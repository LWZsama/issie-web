module WebFiles

#if ISSIE_WEB
open Fable.Core
open JSHelpers

// The desktop picker returns during its click handler. A browser picker completes afterwards.
// Everything after the selection, including validation and project creation, stays with the caller.
[<Emit("window.issieWeb.pickFolder($0)")>]
let private pickFolder (_start: string option) : JS.Promise<string> = jsNative

[<Emit("window.issieWeb.pickSheets($0)")>]
let private pickSheets (_start: string option) : JS.Promise<string array> = jsNative

let private failed dispatch (error: exn) = MenuHelpers.displayFileErrorNotification error.Message dispatch

let folder (_title: string) (_buttonLabel: string) start dispatch useSelection =
    pickFolder start |> Promise.eitherEnd (Option.ofObj >> useSelection) (failed dispatch)

let sheets start dispatch useSelection =
    pickSheets start
    |> Promise.eitherEnd (Array.toList >> function [] -> useSelection None | paths -> useSelection (Some paths))
        (failed dispatch)
#else
let folder title buttonLabel start _dispatch useSelection =
    FilesIO.askForFolder title buttonLabel start |> useSelection

let sheets start _dispatch useSelection =
    FilesIO.askForExistingSheetPaths start |> useSelection
#endif
