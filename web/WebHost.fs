module WebHost

open Fable.Core
open Elmish
open ModelType

[<Emit("window.issieWeb.listen($0, $1)")>]
let private listen (_offer: (unit -> string) -> unit) (_report: string -> unit) : unit -> unit = jsNative

[<Emit("window.issieWeb.projectChanged($0, $1)")>]
let private projectChanged (_path: string option) (_dirty: bool) : unit = jsNative

[<Emit("window.issieWeb.saveCopy($0)")>]
let private saveCopy (_path: string) : unit = jsNative

let private subscribe dispatch =
    let offer mount =
        let openCopy model dispatch =
            mount () |> Option.ofObj |> Option.iter (fun path -> MenuHelpers.openDemoProjectFromPath path model dispatch)
        let ask model dispatch =
            FileUpdate.doActionWithSaveFileDialog "Open shared project" (ExecFuncInMessage(openCopy, dispatch))
                model dispatch ()
        dispatch (ExecFuncInMessage(ask, dispatch))
    let dispose = listen offer (fun message -> MenuHelpers.displayFileErrorNotification message dispatch)
    { new System.IDisposable with member _.Dispose() = dispose () }

let private subscriptions upstream (model: Model) =
    let dirty =
        model.SavedSheetIsOutOfDate ||
        (model.CurrentProj |> Option.exists (fun p -> p.LoadedComponents |> List.exists _.LoadedComponentIsOutOfDate))
    projectChanged (model.CurrentProj |> Option.map _.ProjectPath) dirty
    (["web"; "files"], subscribe) :: upstream model

let attach program =
    let update upstream msg (model: Model) =
        let result = upstream msg model
        match msg, model.CurrentProj with
        | FileCommand (FileSaveOpenFile, _), Some project
        | MenuAction (MenuSaveFile, _), Some project -> saveCopy project.ProjectPath
        | _ -> ()
        result
    Program.map id update id id subscriptions id program
