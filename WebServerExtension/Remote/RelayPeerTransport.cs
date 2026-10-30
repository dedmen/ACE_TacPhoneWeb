using ArmaServerSide.Transports;

namespace ArmaServerSide.Remote
{
    /// <summary>
    /// One browser connected through the relay. Writes application frames into the
    /// single outbound relay socket; inbound frames are routed back by peer id.
    /// </summary>
    internal sealed class RelayPeerTransport : IClientTransport
    {
        readonly RelayConnection _connection;
        readonly string _peerId;

        public RelayPeerTransport(RelayConnection connection, string peerId)
        {
            _connection = connection;
            _peerId = peerId;
        }

        public bool IsOpen => _connection.IsOpen && !string.IsNullOrEmpty(_peerId);

        public Task SendTextAsync(string message) => _connection.SendApplicationAsync(_peerId, message);

        // The relay owns the actual client socket; removal and kick are control frames.
        public Task CloseAsync() => Task.CompletedTask;

        public void Abort() { }
    }
}
