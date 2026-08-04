module BrowserSession

open Browser
open Fable.Core
open Fable.Core.JsInterop

[<Emit("window.onbeforeunload = $0")>]
let private setBeforeUnloadHandler (_handler: obj) : unit = jsNative

let installBeforeUnloadWarning (model: ModelType.Model) =
    if Option.isSome model.CurrentProj then
        setBeforeUnloadHandler (fun (ev: obj) ->
            ev?preventDefault()
            ev?returnValue <- ""
            "")
    else
        setBeforeUnloadHandler null



