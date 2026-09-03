namespace Issie.Sidecar.Wasm

open System
open CommonTypes
open Issie.Sidecar

module private Handler =
    let mutable private sheetCache: Map<string, SimpleSheet> = Map.empty
    let mutable private lastDesign: SimpleDesign option = None
    let mutable private staged: (string * (string * SimpleSheet) list) option = None

    let private responseHeader (header: byte array) =
        let response = Array.copy header
        response[0] <- response[0] ||| Protocol.ResponseFlag
        response

    let private bytesResponse (header: byte array) (payload: byte array) =
        let frame = Array.zeroCreate (Protocol.HeaderSize + payload.Length)
        Array.blit (responseHeader header) 0 frame 0 Protocol.HeaderSize
        Array.blit payload 0 frame Protocol.HeaderSize payload.Length
        frame

    let private textResponse (header: byte array) (text: string) =
        bytesResponse header (Text.Encoding.UTF8.GetBytes text)

    let private errorResponse (header: byte array) (message: string) =
        let frame = textResponse header (sprintf "{\"error\":\"%s\"}" (Protocol.jsonSafe message))
        frame[0] <- frame[0] ||| Protocol.ErrorFlag
        frame

    let private argAt (body: byte array) (offset: int) =
        if body.Length >= offset + 4 then int (BitConverter.ToUInt32(body, offset)) else 0

    let private bodyAfter (body: byte array) (offset: int) =
        if body.Length >= offset then body[offset..] else [||]

    let private lastCycle (startCycle: int) (rep: int) (samples: int) =
        if rep < 1 || samples <= 1 then
            startCycle
        else
            let last = int64 startCycle + int64 (samples - 1) * int64 rep
            if last > int64 Int32.MaxValue then Int32.MaxValue else int last

    let private readableResponse
        (header: byte array)
        (body: byte array)
        (startCycle: int)
        (lastCycle: int)
        (read: unit -> Result<byte array, string>) =
        match SimSession.prepareRead WasmRun.ensureRange (argAt body 0) startCycle lastCycle with
        | Error e -> errorResponse header e
        | Ok() ->
            match read () with
            | Ok payload -> bytesResponse header payload
            | Error e -> errorResponse header e

    let private sendDesign (header: byte array) (body: byte array) =
        let stopwatch = Diagnostics.Stopwatch.StartNew()
        let sheetIndex = argAt body 0
        let sheetCount = argAt body 4

        let outcome =
            DesignCache.parsePayload (bodyAfter body 8)
            |> Result.bind (fun (topSheet, sheetJsons) ->
                match sheetJsons with
                | [ json ] -> Ok(topSheet, json)
                | other -> Error $"expected one sheet in a SendDesign message, got {other.Length}")
            |> Result.bind (fun (topSheet, json) ->
                DesignCache.decodeSheet sheetCache json
                |> Result.map (fun (sheet, wasDecoded, newCache) ->
                    sheetCache <- newCache

                    let soFar =
                        match sheetIndex, staged with
                        | 0, _ ->
                            WasmRun.clearCache ()
                            SimSession.discardForNewDesign ()
                            []
                        | _, Some(_, pairs) -> pairs
                        | _, None -> []

                    let pairs = soFar @ [ json, sheet ]
                    staged <- Some(topSheet, pairs)
                    topSheet, pairs, wasDecoded))

        stopwatch.Stop()

        let reply =
            match outcome with
            | Ok(topSheet, pairs, wasDecoded) ->
                let complete = List.length pairs = sheetCount

                if complete then
                    lastDesign <- Some { TopSheet = topSheet; Sheets = pairs |> List.map snd }
                    sheetCache <- DesignCache.keepOnly (pairs |> List.map fst) sheetCache
                    staged <- None

                sprintf
                    "{\"sheet\":%d,\"of\":%d,\"decoded\":%b,\"complete\":%b,\"deserialiseMs\":%.2f}"
                    sheetIndex
                    sheetCount
                    wasDecoded
                    complete
                    stopwatch.Elapsed.TotalMilliseconds
            | Error e ->
                staged <- None
                sprintf "{\"error\":\"%s\"}" (Protocol.jsonSafe e)

        textResponse header reply

    let private handleFrame (frame: byte array) =
        if frame.Length < Protocol.HeaderSize then
            invalidArg "frame" "sidecar frame is shorter than its header"

        let header = Array.zeroCreate Protocol.HeaderSize
        Array.blit frame 0 header 0 Protocol.HeaderSize
        let body = bodyAfter frame Protocol.HeaderSize

        try
            match header[0] with
            | Protocol.Echo -> bytesResponse header body
            | Protocol.Upload -> responseHeader header
            | Protocol.Download ->
                let requested = argAt body 0
                let size = max 0 (min requested (Protocol.MaxMessage - Protocol.HeaderSize))
                let response = Array.zeroCreate (Protocol.HeaderSize + size)
                Array.blit (responseHeader header) 0 response 0 Protocol.HeaderSize
                Random.Shared.NextBytes response[Protocol.HeaderSize..]
                response
            | Protocol.SendDesign -> sendDesign header body
            | Protocol.SimBuild ->
                let reply =
                    match lastDesign with
                    | None -> "{\"error\":\"no design received - send SendDesign first\"}"
                    | Some design ->
                        WasmRun.clearCache ()
                        SimSession.build design (WasmRun.boundedArraySize (argAt body 0))

                textResponse header reply
            | Protocol.SimRun ->
                textResponse
                    header
                    (SimSession.runWith WasmRun.run (argAt body 0) (argAt body 4) (argAt body 8))
            | Protocol.SimDigest ->
                let reply =
                    match lastDesign with
                    | None -> "{\"error\":\"no design received - send SendDesign first\"}"
                    | Some design -> SimSession.digest design (max 1 (argAt body 0))

                textResponse header reply
            | Protocol.SimEnd ->
                let reply = SimSession.endSession (argAt body 0)

                if reply = "{\"ended\":true}" then
                    WasmRun.clearCache ()

                textResponse header reply
            | Protocol.SimLog -> textResponse header (SimLog.recentJson ())
            | Protocol.SimSetInputs ->
                textResponse
                    header
                    (SimSession.setInputsWith
                         WasmRun.recordInput
                         (argAt body 0)
                         (bodyAfter body 4))
            | Protocol.SimRead ->
                let payload = bodyAfter body 4
                let startCycle = argAt payload 0
                let rep = argAt payload 4
                let samples = argAt payload 8

                readableResponse
                    header
                    body
                    startCycle
                    (lastCycle startCycle rep samples)
                    (fun () -> SimSession.read (argAt body 0) payload)
            | Protocol.SimReadDrivers ->
                let payload = bodyAfter body 4
                let startCycle = argAt payload 0
                let rep = argAt payload 4
                let samples = argAt payload 8

                readableResponse
                    header
                    body
                    startCycle
                    (lastCycle startCycle rep samples)
                    (fun () -> SimSession.readDrivers (argAt body 0) payload)
            | Protocol.SimPorts ->
                match SimSession.ports (argAt body 0) (bodyAfter body 4) with
                | Ok payload -> bytesResponse header payload
                | Error e -> errorResponse header e
            | Protocol.SimReadRam ->
                let payload = bodyAfter body 4
                let cycle = argAt payload 0
                readableResponse
                    header
                    body
                    cycle
                    cycle
                    (fun () -> SimSession.readRam (argAt body 0) payload)
            | command -> errorResponse header $"unknown command {command}"
        with e ->
            errorResponse header $"the WASM sidecar could not answer command {header[0]}: {e.Message}"

    let handle (frame: byte array) = handleFrame frame

type WasmExports =
    static member Handle(frame: string) =
        frame
        |> Convert.FromBase64String
        |> Handler.handle
        |> Convert.ToBase64String
