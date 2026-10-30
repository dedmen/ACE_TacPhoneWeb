using System.Text;
using System.Text.Json.Nodes;

namespace ArmaServerSide
{
    /// <summary>
    /// Diagnostics from the extension. There is no console in the Arma process, so
    /// every message is sent to the game through the extension callback and then
    /// forwarded to the in-game browser (which prints it to its dev console and
    /// shows warnings/errors as notifications).
    /// </summary>
    internal static class ExtensionLog
    {
        private const int MaxMessageLength = 32 * 1024;

        public static void Info(string message) => Write("info", message);

        public static void Warn(string message) => Write("warning", message);

        public static void Error(string message) => Write("error", message);

        public static void Error(string context, Exception exception)
            => Write("error", $"{context}: {exception.GetType().Name}: {exception.Message}{Environment.NewLine}{exception}");

        public static void Warn(string context, Exception exception)
            => Write("warning", $"{context}: {exception.GetType().Name}: {exception.Message}");

        private static void Write(string level, string message)
        {
            if (string.IsNullOrEmpty(message))
                return;

            if (message.Length > MaxMessageLength)
                message = string.Concat(message.AsSpan(0, MaxMessageLength), "… (truncated)");

            var payload = new JsonObject
            {
                ["level"] = level,
                ["message"] = message,
                ["time"] = DateTimeOffset.UtcNow.ToString("O"),
            }.ToJsonString();

            try
            {
                // Before RVExtensionRegisterCallback this is null; the message is lost,
                // which is unavoidable because there is no other output channel.
                // Queue it: ExtensionLog is also called from inside callExtension (game
                // thread) and must not re-enter the callback there.
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try
                    {
                        DllEntry.callback?.Invoke("ArmaWebHost", "Log", Encoding.UTF8.GetBytes(payload));
                    }
                    catch (Exception)
                    {
                        // A failing log callback must never take the extension down.
                    }
                });
            }
            catch (Exception)
            {
                // ThreadPool is gone (shutdown); nothing else we can do.
            }
        }
    }
}
