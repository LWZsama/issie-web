using System;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Threading;
using System.Threading.Tasks;

namespace Issie.Sidecar.Wasm;

[SupportedOSPlatform("browser")]
public static partial class WasmInterop
{
    public static void Main() { }

    [JSImport("send", "issie.worker")]
    internal static partial void Send(int connection, [JSMarshalAs<JSType.Array<JSType.Number>>] byte[] frame);

    [JSExport]
    public static async Task Handle(int connection, [JSMarshalAs<JSType.Array<JSType.Number>>] byte[] frame)
    {
        using var socket = new WorkerFrame(frame);
        await Issie.Sidecar.Program.serve(socket, CancellationToken.None);
        Send(connection, socket.Reply());
    }
}

// A Worker message is one complete WebSocket message. Deliver it in the chunks requested by
// the desktop server, then EOF. Its design cache and simulation session live across messages.
internal sealed class WorkerFrame(byte[] request) : WebSocket
{
    private readonly MemoryStream response = new();
    private int offset;
    private bool delivered;
    private WebSocketCloseStatus? status;
    private string reason;

    public override WebSocketCloseStatus? CloseStatus => status;
    public override string CloseStatusDescription => reason;
    public override WebSocketState State => status.HasValue ? WebSocketState.Closed : WebSocketState.Open;
    public override string SubProtocol => null;
    public override void Abort() => status = WebSocketCloseStatus.InternalServerError;
    public override void Dispose() => response.Dispose();

    public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> target, CancellationToken token)
    {
        if (delivered) return Task.FromResult(new WebSocketReceiveResult(0, WebSocketMessageType.Close, true));
        var count = Math.Min(target.Count, request.Length - offset);
        Array.Copy(request, offset, target.Array, target.Offset, count);
        offset += count;
        delivered = offset == request.Length;
        return Task.FromResult(new WebSocketReceiveResult(count, WebSocketMessageType.Binary, delivered));
    }

    public override Task SendAsync(ArraySegment<byte> data, WebSocketMessageType type, bool end, CancellationToken token)
    {
        response.Write(data.AsSpan());
        return Task.CompletedTask;
    }

    public override Task CloseAsync(WebSocketCloseStatus code, string description, CancellationToken token)
    {
        status = code;
        reason = description;
        return Task.CompletedTask;
    }

    public override Task CloseOutputAsync(WebSocketCloseStatus code, string description, CancellationToken token) =>
        CloseAsync(code, description, token);

    public byte[] Reply() => status == WebSocketCloseStatus.NormalClosure
        ? response.ToArray()
        : throw new IOException(reason ?? "The desktop sidecar closed the connection.");
}
