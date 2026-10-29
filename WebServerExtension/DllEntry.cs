using System.Runtime.InteropServices;
// ReSharper disable InconsistentNaming

// This hosts a simple HTTP webserver, serving files (loaded from in-game, typically only index.html)
// And hosting a Websocket server that passes requests to game (extension callback) and replies back

namespace ArmaServerSide
{
    public static class DllEntry
    {
        public static ExtensionCallback callback = null!;
        public delegate int ExtensionCallback([MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPStr)] string function, [In] byte[] data);


        //[UnmanagedCallersOnly(EntryPoint = "RVExtensionFeatureFlags")]
        //private static extern void NativeFeatureFlags();

        #region Misc RVExtension Requirements

        /// <summary>
        /// Writes <paramref name="text"/> into the buffer Arma passed to the extension and returns
        /// the number of bytes written. Every export answers through this helper, so
        /// <c>callExtension</c> receives a string instead of the previous unconditional "1".
        /// </summary>
        static int WriteOutput(IntPtr output, int outputSize, string? text)
        {
            if (output == IntPtr.Zero || outputSize <= 0) return 0;

            var bytes = System.Text.Encoding.UTF8.GetBytes(text ?? string.Empty);
            var count = Math.Min(bytes.Length, outputSize - 1);
            Marshal.Copy(bytes, 0, output, count);
            Marshal.WriteByte(output, count, 0);
            return count;
        }

        [UnmanagedCallersOnly(EntryPoint = "RVExtensionRegisterCallback")]
        public static void RVExtensionRegisterCallback(IntPtr func)
        {
            // An exception must never cross the native boundary: NativeAOT would terminate Arma.
            try
            {
                callback = Marshal.GetDelegateForFunctionPointer<ExtensionCallback>(func);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"RVExtensionRegisterCallback failed: {ex.Message}");
            }
        }

        [UnmanagedCallersOnly(EntryPoint = "RVExtensionVersion")]
        public static void RvExtensionVersion(IntPtr output, int outputSize)
        {
            WriteOutput(output, outputSize, "1.0.0");
        }

        [UnmanagedCallersOnly(EntryPoint = "RVExtension")]
        public static void RvExtension(IntPtr output, int outputSize, IntPtr function)
        {
            WriteOutput(output, outputSize, string.Empty);
        }

        #endregion

        static WebServer? _webServer = null;

        [UnmanagedCallersOnly(EntryPoint = "RVExtensionArgs")]
        public static unsafe int RvExtensionArgs(IntPtr output, int outputSize, IntPtr methodP, IntPtr argsP, int argCount)
        {
            try
            {
                string method = Marshal.PtrToStringUTF8(methodP) ?? string.Empty;
                var args = new Span<IntPtr>(argsP.ToPointer(), argCount);

                switch (method)
                {
                    case "StartServer" when args.Length >= 1:
                    {
                        if (!int.TryParse(Marshal.PtrToStringUTF8(args[0]), out var port) || port <= 0 || port > 65535)
                            return WriteOutput(output, outputSize, "ERROR: invalid port");

                        if (_webServer != null)
                        {
                            _webServer.Stop();
                            _webServer = null;
                        }

                        var server = new WebServer(port);

                        // Publish before starting: a file request that arrives while Kestrel is
                        // starting must be able to find the instance and complete its wait.
                        _webServer = server;

                        try
                        {
                            server.Start();
                        }
                        catch (Exception ex)
                        {
                            _webServer = null;
                            Console.WriteLine($"WebServer failed to start: {ex.Message}");

                            // Release a half-built host; Start() may have failed after binding.
                            try { server.Stop(); } catch (Exception) { /* already shutting down */ }

                            return WriteOutput(output, outputSize, $"ERROR: {ex.Message}");
                        }

                        return WriteOutput(output, outputSize, "OK");
                    }
                    case "SendTo" when args.Length >= 2:
                    {
                        var target = Marshal.PtrToStringUTF8(args[0])!;
                        var content = Marshal.PtrToStringUTF8(args[1])!;

                        if (_webServer == null)
                            return WriteOutput(output, outputSize, "ERROR: server not running");

                        _webServer.SendTo(target, content);
                        return WriteOutput(output, outputSize, "OK");
                    }
                    case "FileContent" when args.Length >= 2:
                    {
                        var fileName = Marshal.PtrToStringUTF8(args[0])!;
                        var content = Marshal.PtrToStringUTF8(args[1])!;

                        if (_webServer == null)
                            return WriteOutput(output, outputSize, "ERROR: server not running");

                        _webServer.HandleFileContent(fileName, content);
                        return WriteOutput(output, outputSize, "OK");
                    }
                }

                return WriteOutput(output, outputSize, "ERROR: unknown method " + method);
            }
            catch (Exception ex)
            {
                return WriteOutput(output, outputSize, $"ERROR: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }
}
