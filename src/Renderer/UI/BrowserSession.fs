module BrowserSession

open Browser
open CommonTypes
open Fable.Core
open Fable.Core.JsInterop
open Fable.SimpleJson
open ModelType
open MenuHelpers
open Helpers
open FilesIO
open Sheet.SheetInterface

[<Emit("window.__issieBrowserFiles.saveSessionSnapshot($0)")>]
let private saveSessionSnapshotJs (_json: string) : unit = jsNative

[<Emit("window.__issieBrowserFiles.loadSessionSnapshot()")>]
let private loadSessionSnapshotJs () : obj = jsNative

[<Emit("window.__issieBrowserFiles.clearSessionSnapshot()")>]
let private clearSessionSnapshotJs () : unit = jsNative

[<Emit("window.__issieBrowserFiles.beginSessionRestore()")>]
let private beginSessionRestoreJs () : unit = jsNative

[<Emit("window.__issieBrowserFiles.endSessionRestore()")>]
let private endSessionRestoreJs () : unit = jsNative

[<Emit("window.onbeforeunload = $0")>]
let private setBeforeUnloadHandler (_handler: obj) : unit = jsNative

type SessionSnapshot = {
    ProjectPath: string
    OpenFileName: string
    OpenFileContents: string option
    SavedSheetIsOutOfDate: bool
    UISheetTrail: string list
}

let private tryFindOpenSheet project =
    project.LoadedComponents
    |> List.tryFind (fun loadedComponent -> loadedComponent.Name = project.OpenFileName)

let clearSessionSnapshot () =
    clearSessionSnapshotJs ()

let persistSessionSnapshot (model: ModelType.Model) =
    match model.CurrentProj with
    | None -> ()
    | Some project ->
        match tryFindOpenSheet project with
        | None -> ()
        | Some loadedComponent ->
            let sheetInfo: SheetInfo = {
                Form = loadedComponent.Form
                Description = loadedComponent.Description
                ParameterDefinitions = loadedComponent.LCParameterSlots
            }

            let snapshot = {
                ProjectPath = project.ProjectPath
                OpenFileName = project.OpenFileName
                OpenFileContents = Some <| stateToJsonString (model.Sheet.GetCanvasState(), getSavedWave model, Some sheetInfo)
                SavedSheetIsOutOfDate = model.SavedSheetIsOutOfDate
                UISheetTrail = model.UISheetTrail
            }

            Json.serialize snapshot
            |> saveSessionSnapshotJs

let installBeforeUnloadWarning (model: ModelType.Model) =
    if model.SavedSheetIsOutOfDate then
        setBeforeUnloadHandler (fun (ev: obj) ->
            ev?preventDefault()
            ev?returnValue <- ""
            "")
    else
        setBeforeUnloadHandler null

let private chooseResolvedComponent = function
    | Resolve (loadedComponent, autoComponent) when loadedComponent.TimeStamp < autoComponent.TimeStamp -> autoComponent
    | Resolve (loadedComponent, _) -> loadedComponent
    | OkComp loadedComponent
    | OkAuto loadedComponent -> loadedComponent

let private restoreOpenFileFromSnapshot (snapshot: SessionSnapshot) (loadedComponents: LoadedComponent list) =
    match snapshot.OpenFileContents with
    | None -> loadedComponents
    | Some savedContents ->
        match jsonStringToState savedContents with
        | Error _ -> loadedComponents
        | Ok savedState ->
            let restoredCanvas = getLatestCanvas savedState
            let restoredFilePath = pathJoin [| snapshot.ProjectPath; snapshot.OpenFileName + ".dgm" |]
            let restoredComponent, _ =
                makeLoadedComponentFromCanvasData
                    restoredCanvas
                    restoredFilePath
                    savedState.getTimeStamp
                    savedState.getWaveInfo
                    savedState.getSheetInfo

            loadedComponents
            |> List.map (fun loadedComponent ->
                if loadedComponent.Name = snapshot.OpenFileName then
                    restoredComponent
                else
                    loadedComponent)

let private finishSessionRestore _ _ =
    endSessionRestoreJs ()

let restoreSessionSnapshot (model: ModelType.Model) (dispatch: Msg -> unit) =
    beginSessionRestoreJs ()

    loadSessionSnapshotJs ()
    |> function
        | value when isNullOrUndefined value ->
            endSessionRestoreJs ()
        | value ->
            match Json.tryParseAs<SessionSnapshot> (unbox<string> value) with
            | Error _ ->
                clearSessionSnapshotJs ()
                endSessionRestoreJs ()
            | Ok snapshot ->
                match loadAllComponentFiles snapshot.ProjectPath with
                | Error _ ->
                    endSessionRestoreJs ()
                | Ok loadStatuses ->
                    let loadedComponents =
                        loadStatuses
                        |> List.map chooseResolvedComponent
                        |> restoreOpenFileFromSnapshot snapshot

                    match loadedComponents with
                    | [] ->
                        clearSessionSnapshotJs ()
                        endSessionRestoreJs ()
                    | _ ->
                        let openFileName =
                            if loadedComponents |> List.exists (fun loadedComponent -> loadedComponent.Name = snapshot.OpenFileName) then
                                snapshot.OpenFileName
                            else
                                loadedComponents.Head.Name

                        let restoredModel =
                            { model with
                                UISheetTrail = snapshot.UISheetTrail
                                SavedSheetIsOutOfDate = snapshot.SavedSheetIsOutOfDate
                            }

                        setupProjectFromComponents false openFileName loadedComponents restoredModel dispatch
                        dispatch <| DispatchDelayed(200, UpdateModel(fun currentModel ->
                            { currentModel with
                                UISheetTrail = snapshot.UISheetTrail
                                SavedSheetIsOutOfDate = snapshot.SavedSheetIsOutOfDate
                            }))
                        dispatch <| DispatchDelayed(400, ExecFuncInMessage(finishSessionRestore, dispatch))


