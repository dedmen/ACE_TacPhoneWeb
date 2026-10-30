using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;

namespace ArmaServerSide
{


    // Connection Manager Class
    public class WebSocketConnectionManager
    {
        internal readonly ConcurrentDictionary<string, WebSocketConnection> _connections = new();

        public Task AddConnectionAsync(string connectionId, WebSocket webSocket)
        {
            _connections.TryAdd(connectionId, new WebSocketConnection(webSocket));
            Console.WriteLine($"Connection added: {connectionId}. Total connections: {_connections.Count}");
            return Task.CompletedTask;
        }

        public async Task RemoveConnectionAsync(string connectionId)
        {
            if (_connections.TryRemove(connectionId, out var connection))
            {
                // Tell the game this client is gone so it can drop its data interests.
                try
                {
                    DllEntry.callback("ArmaWebHost", "Disconnect", Encoding.UTF8.GetBytes(connectionId));
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Disconnect callback failed: {ex.Message}");
                }

                var webSocket = connection.WebSocket;
                if (webSocket.State == WebSocketState.Open)
                {
                    await CloseSafelyAsync(webSocket, WebSocketCloseStatus.NormalClosure, "Connection closed");
                }

                Console.WriteLine($"Connection removed: {connectionId}. Total connections: {_connections.Count}");
            }
        }

        /// <summary>
        /// Closes a socket without ever hanging: a peer that stopped responding
        /// cannot complete the close handshake, so abort after 2 s.
        /// </summary>
        internal static async Task CloseSafelyAsync(WebSocket socket, WebSocketCloseStatus status, string? description)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await socket.CloseAsync(status, description ?? string.Empty, cts.Token);
            }
            catch (Exception)
            {
                socket.Abort();
            }
        }

        public async Task BroadcastAsync(string message, string? excludeConnectionId = null)
        {
            var tasks = new List<Task>();

            foreach (var connection in _connections)
            {
                if (connection.Key != excludeConnectionId && connection.Value.WebSocket.State == WebSocketState.Open)
                {
                    tasks.Add(SendMessageToConnectionAsync(connection.Value, message));
                }
            }

            await Task.WhenAll(tasks);
        }

        /// <summary>
        /// Broadcast to all currently open connections (wildcard "*").
        /// Returns the number of connections that received the message.
        /// </summary>
        public int CountOpenConnections()
        {
            int count = 0;
            foreach (var connection in _connections)
            {
                if (connection.Value.WebSocket.State == WebSocketState.Open)
                {
                    count++;
                }
            }
            return count;
        }

        private async Task SendMessageToConnectionAsync(WebSocketConnection connection, string message)
        {
            // WebSocket only allows one send at a time, so serialize sends per connection.
            await connection.SendLock.WaitAsync();
            try
            {
                var webSocket = connection.WebSocket;
                if (webSocket.State != WebSocketState.Open)
                {
                    return;
                }

                var bytes = Encoding.UTF8.GetBytes(message);
                await webSocket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error sending message: {ex.Message}");
            }
            finally
            {
                connection.SendLock.Release();
            }
        }

        public async Task SendMessageToConnectionAsync(string connectionId, string message)
        {
            if (_connections.TryGetValue(connectionId, out var connection))
            {
                await SendMessageToConnectionAsync(connection, message);
            }

            //#TODO error?
        }

        internal sealed class WebSocketConnection
        {
            public WebSocket WebSocket { get; }
            public SemaphoreSlim SendLock { get; } = new(1, 1);

            public WebSocketConnection(WebSocket webSocket)
            {
                WebSocket = webSocket;
            }
        }
    }

    internal class WebServer
    {
        WebApplication app = null!;

        // Set when the host starts shutting down; every WebSocket wait observes it.
        readonly CancellationTokenSource _stopping = new();
        volatile bool _stopped;

        public WebServer(int port)
        {
            var builder = WebApplication.CreateBuilder();

            // Add services to the container
            builder.Services.AddSingleton<WebSocketConnectionManager>();
            builder.Services.AddCors(options =>
            {
                // Cross-origin access is only needed by the local Vite dev server. The
                // production web app is served by this host, so its requests are same-origin
                // and do not need CORS at all.
                options.AddPolicy("AllowWebApp",
                    policy =>
                    {
                        policy.SetIsOriginAllowed(origin => IsLoopbackOrigin(origin))
                              .AllowAnyHeader()
                              .AllowAnyMethod();
                    });
            });

            // A dead WebSocket peer must not hold up a mission restart for the
            // default 30 s shutdown timeout.
            builder.Services.Configure<HostOptions>(
                options => options.ShutdownTimeout = TimeSpan.FromSeconds(2));

            builder.WebHost.UseUrls($"https://[::]:{port}");

            app = builder.Build();

            // Configure the HTTP request pipeline
            if (app.Environment.IsDevelopment())
            {
                app.UseDeveloperExceptionPage();
            }

            app.UseCors("AllowWebApp");
            app.UseWebSockets();

            // WebSocket endpoint
            app.Map("/ws", async context =>
            {
                // The page can be served from any LAN IP or hostname, so accept an Origin
                // whose authority matches this request's Host. Browsers always send Origin;
                // clients without one (curl, scripts) are not part of the app contract.
                var origin = context.Request.Headers.Origin.ToString();
                if (!IsAllowedOrigin(origin, context.Request))
                {
                    Console.WriteLine($"Rejected WebSocket origin '{origin}' for host '{context.Request.Host}'");
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return;
                }

                if (context.WebSockets.IsWebSocketRequest)
                {
                    var connectionManager = context.RequestServices.GetService<WebSocketConnectionManager>()!;

                    var webSocket = await context.WebSockets.AcceptWebSocketAsync();
                    var connectionId = Guid.NewGuid().ToString();

                    await connectionManager.AddConnectionAsync(connectionId, webSocket);
                    await HandleWebSocketAsync(connectionId, webSocket, connectionManager, _stopping.Token);
                }
                else
                {
                    context.Response.StatusCode = 400;
                }
            });

            // Serve app files (index.html, bundled apps, icons, ...) from the game filesystem.
            // A catch-all is required: the app bundle imports other files by path, and they
            // must be resolvable from whatever origin the page was loaded from.
            app.MapGet("/{**filePath}", async context =>
            {
                // Ask Arma for the file

                var fileName = context.Request.Path.Value;
                if (string.IsNullOrEmpty(fileName))
                {
                    fileName = "/";
                }

                var promise = GetOrCreatePendingFile(fileName, out var created);
                if (created)
                {
                    DllEntry.callback("ArmaWebHost", "GetFile", System.Text.Encoding.UTF8.GetBytes(fileName));
                }

                // Wait for Arma to reply
                var completed = await Task.WhenAny(promise.Task, Task.Delay(2000));
                if (completed != promise.Task) // Timeout
                {
                    // Stop waiting and remove the stale request so it cannot leak.
                    RemovePendingFile(fileName, promise);
                    promise.TrySetCanceled();

                    context.Response.StatusCode = StatusCodes.Status504GatewayTimeout;
                    context.Response.ContentType = "text/plain";
                    await context.Response.WriteAsync("Timed out waiting for file content.");
                    return;
                }

                string myResult;
                try
                {
                    myResult = await promise.Task;
                }
                catch (OperationCanceledException)
                {
                    // Another request for the same file timed out and cancelled the shared wait.
                    context.Response.StatusCode = StatusCodes.Status504GatewayTimeout;
                    context.Response.ContentType = "text/plain";
                    await context.Response.WriteAsync("Timed out waiting for file content.");
                    return;
                }

                // The game answers with an empty string when the file does not exist.
                if (string.IsNullOrEmpty(myResult))
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    context.Response.ContentType = "text/plain";
                    await context.Response.WriteAsync($"File not found: {fileName}");
                    return;
                }

                context.Response.ContentType = GetContentType(fileName);
                await context.Response.Body.WriteAsync(System.Text.Encoding.UTF8.GetBytes(myResult));
            });

            // Listening is started explicitly by Start(), so the caller can report
            // bind and certificate failures to the game instead of failing silently.
        }

        /// <summary>Starts listening. Throws when the port or the TLS certificate is unusable.</summary>
        public void Start()
        {
            app.StartAsync().GetAwaiter().GetResult();
        }

        /// <summary>
        /// Origin validation for the WebSocket endpoint. The web app is served by this
        /// server, so a legitimate Origin is <c>https://&lt;Host header&gt;</c> regardless
        /// of which LAN address (IP or hostname) the client used to reach us. Loopback
        /// origins are always allowed so the Vite dev server can connect.
        /// </summary>
        private static bool IsAllowedOrigin(string origin, HttpRequest request)
        {
            if (string.IsNullOrEmpty(origin) || string.Equals(origin, "null", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
            {
                return false;
            }

            if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            {
                return false;
            }

            if (IsLoopbackHost(uri.Host))
            {
                return true;
            }

            if (uri.Scheme != Uri.UriSchemeHttps)
            {
                return false;
            }

            // Compare host and port, treating a missing port as the scheme default.
            if (!string.Equals(uri.Host, request.Host.Host, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var originPort = uri.IsDefaultPort ? 443 : uri.Port;
            var requestPort = request.Host.Port ?? (request.IsHttps ? 443 : 80);
            return originPort == requestPort;
        }

        private static bool IsLoopbackOrigin(string origin)
        {
            return Uri.TryCreate(origin, UriKind.Absolute, out var uri)
                && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
                && IsLoopbackHost(uri.Host);
        }

        private static bool IsLoopbackHost(string host)
        {
            if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            // Uri.Host keeps IPv6 literals bracketed ([::1]), which IPAddress cannot parse.
            var addressText = host.Length > 1 && host[0] == '[' && host[^1] == ']'
                ? host[1..^1]
                : host;

            return IPAddress.TryParse(addressText, out var address) && IPAddress.IsLoopback(address);
        }

        /// <summary>
        /// Content type for app files. Modules must be served as JavaScript or the browser
        /// refuses to execute them, so this is not merely cosmetic.
        /// </summary>
        /// <remarks>Only text-based formats are supported. Binary assets (images, fonts, WASM)
        /// cannot be handled due to UTF-8 string conversion limitations in the C++ bridge.</remarks>
        private static string GetContentType(string fileName)
        {
            // The root is served as the app entry point (index.html).
            if (fileName.Length == 0 || fileName == "/")
            {
                return "text/html; charset=utf-8";
            }

            var extension = Path.GetExtension(fileName).ToLowerInvariant();

            return extension switch
            {
                ".html" or ".htm" => "text/html; charset=utf-8",
                ".js" or ".mjs" => "text/javascript; charset=utf-8",
                ".css" => "text/css; charset=utf-8",
                ".json" => "application/json; charset=utf-8",
                ".map" => "application/json; charset=utf-8",
                ".svg" => "image/svg+xml",
                _ => "application/octet-stream",
            };
        }


        public void Stop()
        {
            _stopped = true;

            try { _stopping.Cancel(); }
            catch (Exception) { /* already disposed */ }

            try
            {
                // Bounded: StopAsync must not block the Arma main thread on a dead peer.
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                app.StopAsync(cts.Token).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                // Do not risk a blocking DisposeAsync after a failed stop.
                Console.WriteLine($"WebServer stop failed: {ex.Message}");
                return;
            }

            try { app.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
            catch (Exception ex) { Console.WriteLine($"WebServer dispose failed: {ex.Message}"); }
        }



        static async Task HandleWebSocketAsync(string connectionId, WebSocket webSocket, WebSocketConnectionManager connectionManager, CancellationToken stopping)
        {
            const int receiveBufferSize = 1024 * 4;
            const int maxMessageSize = 30 * 1024 * 1024;
            var buffer = new byte[receiveBufferSize];

            try
            {
                // Send welcome message
                await connectionManager.SendMessageToConnectionAsync(connectionId, $"{{\"type\": \"welcome\", \"message\": \"Connection {connectionId} established!\"}}");

                while (!stopping.IsCancellationRequested && (webSocket.State == WebSocketState.Open || webSocket.State == WebSocketState.CloseReceived))
                {
                    using var messageStream = new MemoryStream();
                    WebSocketReceiveResult result;

                    // A message can span multiple frames, so keep receiving until EndOfMessage.
                    do
                    {
                        result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), stopping);

                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            break;
                        }

                        if (messageStream.Length + result.Count > maxMessageSize)
                        {
                            await WebSocketConnectionManager.CloseSafelyAsync(webSocket, WebSocketCloseStatus.MessageTooBig, "Message too large");
                            await connectionManager.RemoveConnectionAsync(connectionId);
                            return;
                        }

                        messageStream.Write(buffer, 0, result.Count);
                    }
                    while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await connectionManager.RemoveConnectionAsync(connectionId);
                        await WebSocketConnectionManager.CloseSafelyAsync(webSocket, result.CloseStatus ?? WebSocketCloseStatus.NormalClosure, result.CloseStatusDescription);
                        return;
                    }

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var messageJson = Encoding.UTF8.GetString(messageStream.GetBuffer(), 0, (int)messageStream.Length);
                        //#TODO validate its valid json?

                        //#TODO separately implement file read requests here, and we can send response in binary

                        // This should be format { k: "keystring", d: {...} }, same as what usually goes direct to Arma
                        // We pass this to Arma, but we need to tell it where it should send the reply to, the websocket client here
                        messageJson = messageJson.Insert(1, $"\"s\":\"{connectionId}\", ");

                        DllEntry.callback("ArmaWebHost", "Request", System.Text.Encoding.UTF8.GetBytes(messageJson));
                        // Arma will reply by calling WebServer.SendTo with the connectionId
                    }
                }

                await connectionManager.RemoveConnectionAsync(connectionId);
            }
            catch (OperationCanceledException)
            {
                // Host is shutting down (mission restart): drop the connection now
                // instead of waiting for a peer that may never answer.
                webSocket.Abort();
                await connectionManager.RemoveConnectionAsync(connectionId);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error handling WebSocket connection {connectionId}: {ex.Message}");
                webSocket.Abort();
                await connectionManager.RemoveConnectionAsync(connectionId);
            }
        }

        Dictionary<string, string> _fileCache = new();
        ConcurrentDictionary<string, TaskCompletionSource<string>> _filesWaiting = new();

        private TaskCompletionSource<string> GetOrCreatePendingFile(string fileName, out bool created)
        {
            while (true)
            {
                if (_filesWaiting.TryGetValue(fileName, out var existing))
                {
                    created = false;
                    return existing;
                }

                var promise = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                if (_filesWaiting.TryAdd(fileName, promise))
                {
                    created = true;
                    return promise;
                }
            }
        }

        private void RemovePendingFile(string fileName, TaskCompletionSource<string> promise)
        {
            // Only remove the entry if it still belongs to this request.
            ((ICollection<KeyValuePair<string, TaskCompletionSource<string>>>)_filesWaiting)
                .Remove(new KeyValuePair<string, TaskCompletionSource<string>>(fileName, promise));
        }

        internal void HandleFileContent(string fileName, string content)
        {
            // The game sent us content for a file
            if (_stopped) return;

            try
            {
                if (_filesWaiting.TryRemove(fileName, out var compSource))
                {
                    compSource.TrySetResult(content);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"HandleFileContent failed: {ex.Message}");
            }

            //#TODO cache it, files don't change. _fileCache. Also needs to be threadsafe And if not in cache, need to reuse the existing promise
        }

        /// <summary>
        /// Sends content to a list of targets (connection ids or wildcards).
        /// - Content is delivered via asynchronous sends; this returns immediately.
        /// - Returns the number of targets that were successfully connected and open.
        /// - "*" means broadcast to all currently open sockets; other remote ids are ignored when "*" is present.
        /// - Empty/whitespace target ids are skipped. Explicit ids that are not connected are counted as undelivered and logged once per call.
        /// </summary>
        internal int SendTo(IReadOnlyList<string> targets, string content)
        {
            if (_stopped) return 0;

            try
            {
                var connectionManager = app.Services.GetService<WebSocketConnectionManager>()!;

                // Normalize targets: drop empty/whitespace, dedupe (Ordinal), handle "*"
                var normalizedTargets = new HashSet<string>(StringComparer.Ordinal);
                
                foreach (var target in targets)
                {
                    string? trimmed = target?.Trim();
                    if (!string.IsNullOrEmpty(trimmed))
                    {
                        normalizedTargets.Add(trimmed);
                    }
                }

                // If "*" is present, collapse to broadcast and ignore other remote ids
                int delivered;
                if (normalizedTargets.Contains("*"))
                {
                    // Broadcast to all open connections
                    // Fire-and-forget, consistent with the explicit-target path below.
                    _ = connectionManager.BroadcastAsync(content, null);
                    delivered = connectionManager.CountOpenConnections();
                }
                else
                {
                    delivered = 0;
                    foreach (var target in normalizedTargets)
                    {
                        // Send to specific connection (fire-and-forget for async)
                        _ = connectionManager.SendMessageToConnectionAsync(target, content);
                        
                        // Count only if the connection exists and is open
                        if (connectionManager._connections.TryGetValue(target, out var conn) && 
                            conn.WebSocket.State == WebSocketState.Open)
                        {
                            delivered++;
                        }
                    }

                    if (delivered < normalizedTargets.Count)
                    {
                        Console.WriteLine($"SendTo: {normalizedTargets.Count - delivered} of {normalizedTargets.Count} target(s) were not connected");
                    }
                }

                return delivered;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"SendTo failed: {ex.Message}");
                return 0;
            }
        }
    }
}
