module BrowserSession

open Browser
open Fable.Core
open Fable.Core.JsInterop
open ModelType

[<Emit("window.__issieBrowserFiles.clearSessionSnapshot()")>]
let private clearSessionSnapshotJs () : unit = jsNative

[<Emit("window.onbeforeunload = $0")>]
let private setBeforeUnloadHandler (_handler: obj) : unit = jsNative

let clearSessionSnapshot () =
    clearSessionSnapshotJs ()

let persistSessionSnapshot (_model: ModelType.Model) =
    ()

let installBeforeUnloadWarning (model: ModelType.Model) =
    if Option.isSome model.CurrentProj then
        setBeforeUnloadHandler (fun (ev: obj) ->
            ev?preventDefault()
            ev?returnValue <- ""
            "")
    else
        setBeforeUnloadHandler null

let restoreSessionSnapshot (_model: ModelType.Model) (_dispatch: Msg -> unit) =
    clearSessionSnapshotJs ()



