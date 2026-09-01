using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

namespace Issie.Sidecar.Wasm;

[SupportedOSPlatform("browser")]
public static partial class WasmInterop
{
    [JSExport]
    public static string Handle(string frame) => WasmExports.Handle(frame);
}
