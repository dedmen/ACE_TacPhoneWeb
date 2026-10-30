namespace TacPhone.RemoteServer.Tests.Storage;

/// <summary>
/// Deterministic <see cref="TimeProvider"/> for tests. The current instant is a
/// single atomic tick count, so it is safe to read from parallel test code.
/// </summary>
public sealed class TestClock : TimeProvider
{
    private long _ticks;

    public TestClock(DateTimeOffset start)
    {
        _ticks = start.ToUniversalTime().UtcTicks;
    }

    /// <summary>2026-10-30T12:00:00Z, the fixed instant every test starts at.</summary>
    public static TestClock Create() =>
        new(new DateTimeOffset(2026, 10, 30, 12, 0, 0, TimeSpan.Zero));

    public override DateTimeOffset GetUtcNow() =>
        new(Interlocked.Read(ref _ticks), TimeSpan.Zero);

    public void Advance(TimeSpan delta) =>
        Interlocked.Add(ref _ticks, delta.Ticks);

    public void SetUtcNow(DateTimeOffset value) =>
        Interlocked.Exchange(ref _ticks, value.ToUniversalTime().UtcTicks);

    /// <summary>Current instant as unix seconds, the unit the repository stores.</summary>
    public long UnixSeconds => GetUtcNow().ToUnixTimeSeconds();
}
