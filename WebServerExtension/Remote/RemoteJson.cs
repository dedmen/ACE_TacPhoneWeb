using System.Text;
using System.Text.Json.Nodes;
using ArmaServerSide.Transports;

namespace ArmaServerSide.Remote
{
    internal sealed partial class RemoteAccessService
    {
        void NotifyIdentity()
        {
            var json = new JsonObject
            {
                ["hostId"] = _hostId,
                ["secret"] = _hostSecret,
            }.ToJsonString();

            try
            {
                DllEntry.callback("ArmaWebHost", "RemoteIdentity", Encoding.UTF8.GetBytes(json));
            }
            catch (Exception ex)
            {
                ExtensionLog.Error("RemoteIdentity callback failed", ex);
            }
        }

        void DropAllPeers()
        {
            foreach (var peerId in _peers.Keys)
            {
                if (!_peers.TryRemove(peerId, out _))
                    continue;

                _ = _connections.RemoveConnectionAsync(peerId, notifyGame: true, closeTransport: false);
            }
        }

        static string Ok() => new JsonObject { ["ok"] = true }.ToJsonString();

        static string Error(string message)
            => new JsonObject { ["ok"] = false, ["error"] = message }.ToJsonString();

        /// <summary>
        /// Parses the manifest the web UI sends with RemoteAccess.Start:
        /// a JSON array of { "path": "...", "hash": "<lowercase hex>" }.
        /// Invalid entries are skipped; the list is capped so a broken client cannot
        /// grow the control frame without bound.
        /// </summary>
        static JsonArray ParseFileManifest(string json)
        {
            const int MaxEntries = 512;
            const int MaxPathLength = 512;

            var result = new JsonArray();
            if (string.IsNullOrWhiteSpace(json))
                return result;

            JsonArray? parsed;
            try
            {
                parsed = JsonNode.Parse(json) as JsonArray;
            }
            catch (Exception)
            {
                ExtensionLog.Warn("Ignoring a malformed file manifest");
                return result;
            }

            if (parsed is null)
                return result;

            foreach (var node in parsed)
            {
                if (result.Count >= MaxEntries)
                    break;

                if (node is not JsonObject entry)
                    continue;

                var path = entry["path"]?.GetValue<string>();
                var hash = entry["hash"]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(hash) || path.Length > MaxPathLength)
                    continue;

                result.Add((JsonNode)new JsonObject
                {
                    ["path"] = path,
                    ["hash"] = hash.Trim().ToLowerInvariant(),
                });
            }

            return result;
        }

        JsonObject BuildFileManifestFrameLocked()
        {
            var files = new JsonArray();
            foreach (var node in _fileManifest)
            {
                if (node is not null)
                    files.Add(node.DeepClone());
            }

            return new JsonObject { ["t"] = "files", ["files"] = files };
        }

        async Task SendFileManifestAsync(RelayConnection connection)
        {
            JsonObject frame;
            lock (_gate)
            {
                if (_fileManifest.Count == 0)
                    return;

                frame = BuildFileManifestFrameLocked();
            }

            try
            {
                await connection.SendControlAsync(frame).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                ExtensionLog.Error("Could not send the file manifest", ex);
            }
        }

        /// <summary>
        /// Accepts `tacphone.arma3.io`, `https://host`, `wss://host/ws`, ... and
        /// returns the relay WebSocket URI plus the public browser base URL.
        /// </summary>
        static Uri? BuildRelayUri(string host, out string publicBase)
        {
            publicBase = "";

            if (string.IsNullOrWhiteSpace(host))
                return null;

            var text = host.Trim();
            if (!text.Contains("://", StringComparison.Ordinal))
                text = "wss://" + text;

            if (!Uri.TryCreate(text, UriKind.Absolute, out var parsed))
                return null;

            var secure = parsed.Scheme is "wss" or "https";
            if (!secure && parsed.Scheme is not ("ws" or "http"))
                return null;

            var path = parsed.AbsolutePath.TrimEnd('/');
            if (path.Length == 0)
                path = "/ws";

            var builder = new UriBuilder(parsed)
            {
                Scheme = secure ? "wss" : "ws",
                Path = path,
                Query = string.Empty,
                Fragment = string.Empty,
            };

            publicBase = $"{(secure ? "https" : "http")}://{parsed.Authority}";
            return builder.Uri;
        }
    }
}
