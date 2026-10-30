namespace ArmaServerSide.Transports
{
    /// <summary>
    /// One connected browser. The LAN WebSocket server and the public relay both
    /// produce these, so <see cref="WebSocketConnectionManager"/> and `SendTo`
    /// do not care which transport a client uses.
    /// </summary>
    internal interface IClientTransport
    {
        bool IsOpen { get; }

        /// <summary>Queues one text frame. Implementations serialize their own sends.</summary>
        Task SendTextAsync(string message);

        /// <summary>Best-effort graceful close. Must not block forever.</summary>
        Task CloseAsync();

        /// <summary>Immediate teardown, used when a peer is unresponsive.</summary>
        void Abort();
    }
}
