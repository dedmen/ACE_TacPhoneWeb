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

        [UnmanagedCallersOnly(EntryPoint = "RVExtensionRegisterCallback")]
        public static void RVExtensionRegisterCallback(IntPtr func)
        {
            callback = Marshal.GetDelegateForFunctionPointer<ExtensionCallback>(func);
        }

        [UnmanagedCallersOnly(EntryPoint = "RVExtensionVersion")]
        public static void RvExtensionVersion(IntPtr output, int outputSize)
        {
            var version = "1.0.0\0"u8.ToArray();
            Marshal.Copy(version, 0, output, version.Length);
        }

        [UnmanagedCallersOnly(EntryPoint = "RVExtension")]
        public static void RvExtension(IntPtr output, int outputSize, IntPtr function)
        {
        }

        #endregion

        static WebServer _webServer = null;

        [UnmanagedCallersOnly(EntryPoint = "RVExtensionArgs")]
        public static unsafe int RvExtensionArgs(IntPtr output, int outputSize, IntPtr methodP, IntPtr argsP, int argCount)
        {
            string method = Marshal.PtrToStringUTF8(methodP)!;
            var args = new Span<IntPtr>(argsP.ToPointer(), argCount);

            switch (method)
            {
                case "StartServer" when args.Length >= 1:
                {
                    if (int.TryParse(Marshal.PtrToStringUTF8(args[0]), out var port))
                    {
                        if (_webServer != null)
                        {
                            _webServer.Stop();
                            _webServer = null;
                        }

                        _webServer = new WebServer(port);
                    }
                }
                break;
                case "SendTo" when args.Length >= 2:
                {
                    var target = Marshal.PtrToStringUTF8(args[0])!;
                    var content = Marshal.PtrToStringUTF8(args[1])!;

                    if (_webServer == null)
                        return 0;

                    _webServer.SendTo(target, content);
                }
                break;
                case "FileContent" when args.Length >= 2:
                {
                    var fileName = Marshal.PtrToStringUTF8(args[0])!;
                    var content = Marshal.PtrToStringUTF8(args[1])!;

                    if (_webServer == null)
                        return 0;

                    _webServer.HandleFileContent(fileName, content);
                }
                break;
            }

            return 1;
        }
    }
}
