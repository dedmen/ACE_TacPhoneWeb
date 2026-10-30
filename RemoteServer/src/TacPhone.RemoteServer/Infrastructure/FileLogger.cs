using System.Text;

namespace TacPhone.RemoteServer.Infrastructure;

/// <summary>Options for <see cref="FileLoggerProvider"/>.</summary>
public sealed class FileLoggerOptions
{
    /// <summary>Absolute path of the current log file.</summary>
    public required string Path { get; init; }

    /// <summary>Minimum level written to the file.</summary>
    public LogLevel MinLevel { get; init; } = LogLevel.Information;

    /// <summary>Rotate when the file would exceed this size. 0 disables rotation.</summary>
    public long MaxBytes { get; init; } = 10 * 1024 * 1024;

    /// <summary>How many rotated files to keep (`file.1` … `file.N`).</summary>
    public int KeepFiles { get; init; } = 5;
}

/// <summary>
/// Minimal dependency-free rolling file logger.
///
/// All application logs (including Kestrel/host failures) go here, so a relay
/// running under systemd has a persistent record even when journald is not
/// being watched. Writes are serialized, flushed per line, and never throw into
/// the caller: if the file cannot be opened, logging falls back to the console.
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly FileLoggerOptions _options;
    private readonly object _gate = new();
    private StreamWriter? _writer;
    private long _written;
    private bool _disabled;

    public FileLoggerProvider(FileLoggerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.Path);

        _options = options;
        Path = options.Path;
        TryOpen();
    }

    /// <summary>Absolute path this provider writes to.</summary>
    public string Path { get; }

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);

    internal bool IsEnabled(LogLevel level) =>
        !_disabled && level != LogLevel.None && level >= _options.MinLevel;

    internal void Write(LogLevel level, string category, string message, Exception? exception)
    {
        if (!IsEnabled(level))
            return;

        var block = exception is null
            ? $"{DateTimeOffset.UtcNow:yyyy-MM-ddTHH:mm:ss.fffZ} [{level}] {category}: {message}"
            : $"{DateTimeOffset.UtcNow:yyyy-MM-ddTHH:mm:ss.fffZ} [{level}] {category}: {message}{Environment.NewLine}{exception}";

        lock (_gate)
        {
            if (_disabled)
                return;

            if (!EnsureWriter(Encoding.UTF8.GetByteCount(block) + Environment.NewLine.Length))
                return;

            try
            {
                _writer!.WriteLine(block);
                _written += Encoding.UTF8.GetByteCount(block) + Environment.NewLine.Length;
            }
            catch (Exception ex)
            {
                Disable(ex);
            }
        }
    }

    private bool EnsureWriter(int incomingBytes)
    {
        if (_writer is null && !TryOpen())
            return false;

        if (_options.MaxBytes > 0 && _written + incomingBytes > _options.MaxBytes)
            Roll();

        return _writer is not null;
    }

    private bool TryOpen()
    {
        try
        {
            var directory = System.IO.Path.GetDirectoryName(Path);
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            var stream = new FileStream(Path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            _written = stream.Length;
            _writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
            {
                AutoFlush = true,
            };

            return true;
        }
        catch (Exception ex)
        {
            Disable(ex);
            return false;
        }
    }

    private void Roll()
    {
        try
        {
            CloseWriter();

            if (_options.KeepFiles <= 1)
            {
                File.Delete(Path);
            }
            else
            {
                for (var index = _options.KeepFiles - 1; index >= 1; index--)
                {
                    var source = index == 1 ? Path : $"{Path}.{index - 1}";
                    var destination = $"{Path}.{index}";
                    if (!File.Exists(source))
                        continue;

                    if (File.Exists(destination))
                        File.Delete(destination);

                    File.Move(source, destination);
                }
            }

            TryOpen();
        }
        catch (Exception ex)
        {
            Disable(ex);
        }
    }

    private void CloseWriter()
    {
        try { _writer?.Dispose(); } catch (Exception) { /* best effort */ }
        _writer = null;
    }

    private void Disable(Exception exception)
    {
        if (_disabled)
            return;

        _disabled = true;
        CloseWriter();

        try
        {
            Console.Error.WriteLine(
                $"TacPhone file logging disabled for '{Path}': {exception.GetType().Name}: {exception.Message}");
        }
        catch (Exception)
        {
            // Console is gone too; nothing else we can do.
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _disabled = true;
            CloseWriter();
        }
    }

    private sealed class FileLogger : ILogger
    {
        private readonly FileLoggerProvider _provider;
        private readonly string _category;

        public FileLogger(FileLoggerProvider provider, string category)
        {
            _provider = provider;
            _category = category;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => _provider.IsEnabled(logLevel);

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
                return;

            string message;
            try
            {
                message = formatter(state, exception);
            }
            catch (Exception)
            {
                message = state?.ToString() ?? string.Empty;
            }

            _provider.Write(logLevel, _category, message, exception);
        }
    }
}
