using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
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
        private readonly ConcurrentDictionary<string, WebSocketConnection> _connections = new();

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
                var webSocket = connection.WebSocket;
                if (webSocket.State == WebSocketState.Open)
                {
                    await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Connection closed", CancellationToken.None);
                }

                Console.WriteLine($"Connection removed: {connectionId}. Total connections: {_connections.Count}");

                // Notify remaining clients
                //var notification = new { type = "user_left", connectionId = connectionId, totalConnections = _connections.Count };
                //await BroadcastAsync(JsonSerializer.Serialize(notification));
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

        public int GetConnectionCount() => _connections.Count;

        private sealed class WebSocketConnection
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
        WebApplication app = null;

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
                    await HandleWebSocketAsync(connectionId, webSocket, connectionManager);
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

            app.RunAsync();
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
            app.StopAsync().Wait(); //#TODO don't wait.. please.. Async properly
        }




        static async Task HandleWebSocketAsync(string connectionId, WebSocket webSocket, WebSocketConnectionManager connectionManager)
        {
            const int receiveBufferSize = 1024 * 4;
            const int maxMessageSize = 30 * 1024 * 1024;
            var buffer = new byte[receiveBufferSize];

            try
            {
                // Send welcome message
                await connectionManager.SendMessageToConnectionAsync(connectionId, $"{{\"type\": \"welcome\", \"message\": \"Connection {connectionId} established!\"}}");

                while (webSocket.State == WebSocketState.Open || webSocket.State == WebSocketState.CloseReceived)
                {
                    using var messageStream = new MemoryStream();
                    WebSocketReceiveResult result;

                    // A message can span multiple frames, so keep receiving until EndOfMessage.
                    do
                    {
                        result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);

                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            break;
                        }

                        if (messageStream.Length + result.Count > maxMessageSize)
                        {
                            await webSocket.CloseAsync(WebSocketCloseStatus.MessageTooBig, "Message too large", CancellationToken.None);
                            await connectionManager.RemoveConnectionAsync(connectionId);
                            return;
                        }

                        messageStream.Write(buffer, 0, result.Count);
                    }
                    while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await connectionManager.RemoveConnectionAsync(connectionId);
                        await webSocket.CloseAsync(result.CloseStatus ?? WebSocketCloseStatus.NormalClosure, result.CloseStatusDescription, CancellationToken.None);
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
            catch (Exception ex)
            {
                Console.WriteLine($"Error handling WebSocket connection {connectionId}: {ex.Message}");
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

            if (_filesWaiting.TryRemove(fileName, out var compSource))
            {
                compSource.TrySetResult(content);
            }

            //#TODO cache it, files don't change. _fileCache. Also needs to be threadsafe And if not in cache, need to reuse the existing promise
        }

        internal void SendTo(string target, string content)
        {
            // Send content to specific websocket client
            var websocketManager = app.Services.GetService<WebSocketConnectionManager>()!;
            _ = websocketManager.SendMessageToConnectionAsync(target, content);
        }
    }
}
