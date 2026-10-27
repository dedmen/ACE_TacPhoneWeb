using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using System.Collections.Concurrent;
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
                options.AddPolicy("AllowAll",
                    policy =>
                    {
                        policy.AllowAnyOrigin()
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

            app.UseCors("AllowAll");
            app.UseWebSockets();

            // WebSocket endpoint
            app.Map("/ws", async context =>
            {
                if (context.WebSockets.IsWebSocketRequest)
                {
                    var connectionManager = context.RequestServices.GetService<WebSocketConnectionManager>()!;

                    //#TODO check origin

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

            app.MapGet("/", async context =>
            {
                // Ask Arma for the file

                var fileName = context.Request.Path;

                //if (fileName == "/")
                //    fileName = "index.html";

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

                context.Response.ContentType = "text/html";
                await context.Response.Body.WriteAsync(System.Text.Encoding.UTF8.GetBytes(myResult));
            });

            app.RunAsync();
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
