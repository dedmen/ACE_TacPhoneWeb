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

        private readonly ConcurrentDictionary<string, WebSocket> _connections = new();

        public async Task AddConnectionAsync(string connectionId, WebSocket webSocket)
        {
            _connections.TryAdd(connectionId, webSocket);
            Console.WriteLine($"Connection added: {connectionId}. Total connections: {_connections.Count}");
        }

        public async Task RemoveConnectionAsync(string connectionId)
        {
            if (_connections.TryRemove(connectionId, out var webSocket))
            {
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

        public async Task BroadcastAsync(string message, string excludeConnectionId = null)
        {
            var tasks = new List<Task>();

            foreach (var connection in _connections)
            {
                if (connection.Key != excludeConnectionId && connection.Value.State == WebSocketState.Open)
                {
                    tasks.Add(SendMessageToConnectionAsync(connection.Value, message));
                }
            }

            await Task.WhenAll(tasks);
        }

        private async Task SendMessageToConnectionAsync(WebSocket webSocket, string message)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(message);
                await webSocket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error sending message: {ex.Message}");
            }
        }

        public async Task SendMessageToConnectionAsync(string connectionId, string message)
        {
            if (_connections.TryGetValue(connectionId, out var webSocket))
            {
                await SendMessageToConnectionAsync(webSocket, message);
            }

            //#TODO error?
        }

        public int GetConnectionCount() => _connections.Count;
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

                var promise = new TaskCompletionSource<string>();

                var fileName = context.Request.Path;

                //if (fileName == "/")
                //    fileName = "index.html";

                _filesWaiting.Add(fileName, promise);

                DllEntry.callback("ArmaWebHost", "GetFile", System.Text.Encoding.UTF8.GetBytes(fileName));
                // Wait for Arma to reply

                var completed = await Task.WhenAny(promise.Task, Task.Delay(2000));
                if (completed != promise.Task) // Timeout
                {
                    context.Response.ContentType = "text/html";
                    await context.Response.Body.WriteAsync(System.Text.Encoding.UTF8.GetBytes("aaaaa"));
                }

                var myResult = await promise.Task;

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
            var buffer = new byte[1024 * 4];

            try
            {
                // Send welcome message
                await SendMessageAsync(webSocket, $"{{\"type\": \"welcome\", \"message\": \"Connection {connectionId} established!\"}}");

                WebSocketReceiveResult result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);

                while (!result.CloseStatus.HasValue)
                {
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var messageJson = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        //#TODO validate its valid json?

                        //#TODO separately implement file read requests here, and we can send response in binary

                        // This should be format { k: "keystring", d: {...} }, same as what usually goes direct to Arma
                        // We pass this to Arma, but we need to tell it where it should send the reply to, the websocket client here
                        messageJson = messageJson.Insert(1, $"\"s\":\"{connectionId}\", ");

                        DllEntry.callback("ArmaWebHost", "Request", System.Text.Encoding.UTF8.GetBytes(messageJson));
                        // Arma will reply by calling WebServer.SendTo with the connectionId
                    }

                    result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                }

                await connectionManager.RemoveConnectionAsync(connectionId);
                await webSocket.CloseAsync(result.CloseStatus.Value, result.CloseStatusDescription, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error handling WebSocket connection {connectionId}: {ex.Message}");
                await connectionManager.RemoveConnectionAsync(connectionId);
            }
        }

        static async Task SendMessageAsync(WebSocket webSocket, string message)
        {
            if (webSocket.State == WebSocketState.Open)
            {
                var bytes = Encoding.UTF8.GetBytes(message);
                await webSocket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
            }
        }

        Dictionary<string, string> _fileCache = new();
        Dictionary<string, TaskCompletionSource<string>> _filesWaiting = new();

        internal void HandleFileContent(string fileName, string content)
        {
            // The game sent us content for a file

            if (_filesWaiting.TryGetValue(fileName, out var compSource))
            {
                compSource.SetResult(content);
                _filesWaiting.Remove(fileName);
            }

            //#TODO cache it, files don't change. _fileCache. Also needs to be threadsafe And if not in cache, need to reuse the existing promise
        }

        internal void SendTo(string target, string content)
        {
            // Send content to specific websocket client
            var websocketManager = app.Services.GetService<WebSocketConnectionManager>()!;
            websocketManager.SendMessageToConnectionAsync(target, content);
        }
    }
}
