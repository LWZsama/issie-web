module FileUpdate
open Elmish
open Fable.React
open Fable.React.Props
open ModelType
open ElectronAPI
open FilesIO
open SimGraphTypes
open ModelHelpers
open PopupHelpers
open CommonTypes
open CatalogueView
open TopMenuView
open Sheet.SheetInterface
open DrawModelType
open MenuHelpers
open Optics
open Optics.Optic
open Optics.Operators
open JSHelpers
open BrowserSession

/// force either save of current file before action, or abort (closeProject is special case of this)
/// In addition, if not aborting, save current lockstate of all files.
let doActionWithSaveFileDialog (name: string) (nextAction: Msg)  model dispatch _ =
    let closeDialogButtons keepOpen _ =
        if keepOpen then
            dispatch ClosePopup
        else
            dispatch nextAction

    let lockStateHasChanged =
        match model.CurrentProj with
        | None -> ""
        | Some p ->
            p.LoadedComponents
            |> List.filter (fun c -> c.LoadedComponentIsOutOfDate)
            |> List.map (fun c -> c.Name)
            |> String.concat ","


    if model.SavedSheetIsOutOfDate then 
        choicePopup 
            $"{name}?" 
            (div [] [ str "The current sheet has unsaved changes."])
            "Go back to sheet" 
            $"{name} without saving changes"  
            closeDialogButtons 
            dispatch
    elif lockStateHasChanged <> "" then
        choicePopup 
            $"Do you want to close without saving lock state?" 
            (div [] [ str $"""The lockstate of {lockStateHasChanged} sheets has changed."""])
            "Go back to sheet" 
            $"{name} without saving changes"  
            closeDialogButtons 
            dispatch
    else
        dispatch nextAction

/// Create a new project.
let rec private newProject model dispatch  =
    warnAppWidth dispatch (fun _ ->
        askForNewProjectPathAsync model.UserData.LastUsedDirectory
        |> Promise.eitherEnd
            (function
            | None -> ()
            | Some path ->
                match tryCreateFolder path with
                | Error err ->
                    JSHelpers.log err
                    electronRemote.dialog.showErrorBox("Invalid Project Name", err)
                    newProject model dispatch
                | Ok _ ->
                    dispatch EndSimulation
                    dispatch <| TruthTableMsg CloseTruthTable
                    dispatch EndWaveSim

                    let projectFile = baseName path + ".dprj"
                    let projectFilePath = pathJoin [| path; projectFile |]
                    writeFile projectFilePath ""
                    |> Notifications.displayAlertOnError dispatch

                    let initialComponent = createEmptyComponentAndFile path "main"

                    persistFileToExternalStorageAsync projectFilePath
                    |> Promise.bind (fun _ -> persistFileToExternalStorageAsync initialComponent.FilePath)
                    |> Promise.eitherEnd
                        (fun _ ->
                            dispatch <| SetUserData {model.UserData with LastUsedDirectory = Some path}
                            setupProjectFromComponents false "main" [initialComponent] model dispatch)
                        (fun err -> electronRemote.dialog.showErrorBox("Create project failed", err.Message)))
            (fun err -> electronRemote.dialog.showErrorBox("Create project failed", err.Message)))

/// open an existing project
let private openProject model dispatch =
    warnAppWidth dispatch (fun _ ->
        let dirName =
            match Option.map readFilesFromDirectory model.UserData.LastUsedDirectory with
            | Some [] | None -> None
            | _ -> model.UserData.LastUsedDirectory

        askForExistingProjectPathAsync dirName
        |> Promise.eitherEnd
            (function
            | None -> ()
            | Some path -> openProjectFromPath path model dispatch)
            (fun err -> electronRemote.dialog.showErrorBox("Open project failed", err.Message)))

/// Close current project, if any.
let forceCloseProject (model:Model) dispatch =
    clearSessionSnapshot ()
    dispatch (StartUICmd CloseProject)
    let sheetDispatch sMsg = dispatch (Sheet sMsg) 
    dispatch EndSimulation // End any running simulation.
    dispatch <| TruthTableMsg CloseTruthTable // Close any open Truth Table.
    // End any running simulation.
    dispatch EndSimulation
    dispatch EndWaveSim
    model.Sheet.ClearCanvas sheetDispatch
    dispatch <| UpdateModel (
        fun model ->
            { model with
                RightPaneTabVisible = Properties
                Pending = []}
                )
    dispatch FinishUICmd

/// Implement a command involving file operations from Update, with access to dispatch
/// Invoked by message: `FileCommand(fc,dispatch)`.
/// TODO - refactor to remove dispatch dependence
let fileCommand (fc: FileCommandType) (dispatch: (Msg->Unit)) (model: Model) =
    match fc with
    | FileAddFile ->
        addFileToProject model dispatch
        model, Cmd.none        
    | FileImportSheet ->

        MiscMenuView.importSheet model dispatch
        model, Cmd.none

    | FileNewProject withSave ->
        if withSave then
            doActionWithSaveFileDialog "New project" (ExecFuncInMessage(newProject,dispatch)) model dispatch ()
        else
                newProject model dispatch
        model, Cmd.none

    | FileOpenProject  withSave ->
        if withSave then
            doActionWithSaveFileDialog "Open project" (ExecFuncInMessage(openProject,dispatch)) model dispatch ()
        else
            openProject model dispatch
        model, Cmd.none

    | FileCloseProject  ->
        doActionWithSaveFileDialog "Close project" (ExecFuncInMessage(forceCloseProject,dispatch)) model dispatch ()
        model, Cmd.none

    | FileSaveOpenFile ->
        saveOpenFileActionWithModelUpdate model dispatch |> ignore
        model, Cmd.none

    | FileShowDemos demoOpts ->
        showDemoProjects model dispatch demoOpts
        model, Cmd.none
        
    







