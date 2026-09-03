namespace Issie.Sidecar.Wasm

open CommonTypes
open SimTypes
open NumberHelpers
open TimeHelpers

/// The browser's run-loop adapter.
///
/// The simulation and its compiled reducers remain the upstream FastSimulation. This only keeps
/// the reducer references in compact arrays and runs the no-timeout benchmark path as one tight
/// range. That removes the managed component-field lookup and the two-cycle scheduling loop which
/// are useful for a responsive desktop caller, but unnecessary inside a Worker.
module WasmRun =

    // A full waveform run can be hundreds of thousands of cycles, but the viewer only asks for a
    // window at a time. Keeping that whole history in WASM turns a perfectly usable design into a
    // gigabyte allocation. Older windows are replayed in the Worker when they are requested.
    [<Literal>]
    let maxRetainedCycles = 8192

    let boundedArraySize requested =
        max 2 (min requested maxRetainedCycles)

    let mutable private inputEvents: Map<int, (ComponentId * bigint) list> = Map.empty

    /// Keep browser-side input edits so replaying an older window produces the same input trace.
    /// The desktop runner does not need this because it retains the configured history.
    let recordInput cycle cid value =
        let previous = Map.tryFind cycle inputEvents |> Option.defaultValue []
        let withoutSameComponent = previous |> List.filter (fun (oldCid, _) -> oldCid <> cid)
        inputEvents <- Map.add cycle ((cid, value) :: withoutSameComponent) inputEvents

    type private RunPlan =
        { GlobalInputs: FastComponent array
          GlobalU32Inputs: WasmReducers.Region array
          GlobalU32Defaults: (WasmReducers.Region * uint32) array
          Clocked: WasmReducers.Reducer array
          Ordered: WasmReducers.Reducer array }

    let mutable private cachedPlan: (FastSimulation * RunPlan) option = None

    let clearCache () =
        cachedPlan <- None
        inputEvents <- Map.empty
        WasmReducers.resetPins ()

    let private planFor (fs: FastSimulation) =
        match cachedPlan with
        | Some(cached, plan) when obj.ReferenceEquals(cached, fs) -> plan
        | _ ->
            cachedPlan <- None
            WasmReducers.resetPins ()
            let globalInputs = fs.FGlobalInputComps
            let globalU32Inputs =
                globalInputs
                |> Array.choose (fun fc ->
                    let vec = fc.Outputs[0]
                    if vec.Width <= 32 then Some(WasmReducers.regionFor vec) else None)

            let globalU32Defaults =
                globalInputs
                |> Array.choose (fun fc ->
                    match fc.FType with
                    | Input1(_, Some defaultValue) when fc.Outputs[0].Width <= 32 ->
                        Some(WasmReducers.regionFor fc.Outputs[0], uint32 defaultValue)
                    | _ -> None)

            let plan =
                { GlobalInputs = globalInputs |> Array.filter (fun fc -> fc.Outputs[0].Width > 32)
                  GlobalU32Inputs = globalU32Inputs
                  GlobalU32Defaults = globalU32Defaults
                  Clocked = fs.FClockedComps |> Array.map (fun fc -> WasmReducers.create fc fc.ReduceClocked)
                  Ordered = fs.FOrderedComps |> Array.map (fun fc -> WasmReducers.create fc fc.ReduceComb) }

            cachedPlan <- Some(fs, plan)
            plan

    let private propagateInputs
        (step: int)
        (fs: FastSimulation)
        (u32Inputs: WasmReducers.Region array)
        (bigInputs: FastComponent array)
        =
        let sourceStep = if step = 0 then fs.MaxArraySize else step
        let mutable i = 0

        while i < u32Inputs.Length do
            WasmReducers.copyRegion u32Inputs[i] step (sourceStep - 1)
            i <- i + 1

        i <- 0

        while i < bigInputs.Length do
            let vec = bigInputs[i].Outputs[0]

            vec.SetBig step (vec.Big (sourceStep - 1))

            i <- i + 1

    let private setInputsToDefault
        (u32Defaults: (WasmReducers.Region * uint32) array)
        (bigInputs: FastComponent array)
        =
        let mutable i = 0

        while i < u32Defaults.Length do
            let region, value = u32Defaults[i]
            WasmReducers.writeRegion region 0 value
            i <- i + 1

        i <- 0

        while i < bigInputs.Length do
            let fc = bigInputs[i]

            match fc.FType with
            | Input1(_, Some defaultValue) ->
                let vec = fc.Outputs[0]
                vec.SetBig 0 defaultValue
            | _ -> ()

            i <- i + 1

    let private applyRecordedInputs (step: int) (fs: FastSimulation) =
        match Map.tryFind step inputEvents with
        | None -> ()
        | Some changes ->
            for cid, value in changes do
                match fs.ComponentOf(cid, []) with
                | Some fc ->
                    let fd = NumberHelpers.convertBigintToFastData fc.Outputs[0].Width value
                    let slot = step % fs.MaxArraySize

                    if fd.Width <= 32 then
                        fc.Outputs[0].SetU32 slot fd.GetQUint32
                    else
                        fc.Outputs[0].SetBig slot fd.GetBigInt
                | None -> ()

    let private reduce (reducers: WasmReducers.Reducer array) (step: StepIndex) =
        let mutable i = 0

        while i < reducers.Length do
            WasmReducers.run reducers[i] step
            i <- i + 1

    let private restartSimulation (fs: FastSimulation) (plan: RunPlan) =
        let step =
            { NumStep = 0
              SimStep = 0
              SimStepOld = fs.MaxArraySize - 1 }

        setInputsToDefault plan.GlobalU32Defaults plan.GlobalInputs
        applyRecordedInputs 0 fs
        reduce plan.Clocked step
        reduce plan.Ordered step
        fs.ClockTick <- 0

    /// Advance without touching FastSimulation.ClockTick until the range is complete. Reducers
    /// receive exactly the same StepIndex values and run in exactly the same clocked/ordered
    /// sequence as FastRun.
    let private runSteps (fs: FastSimulation) (plan: RunPlan) (fromTick: int) (target: int) =
        let maxArraySize = fs.MaxArraySize
        let mutable tick = fromTick
        let mutable simStep = fromTick % maxArraySize

        while tick < target do
            let numStep = tick + 1
            let simStepOld = simStep
            simStep <- simStep + 1

            if simStep = maxArraySize then
                simStep <- 0

            let step =
                { NumStep = numStep
                  SimStep = simStep
                  SimStepOld = simStepOld }

            propagateInputs step.SimStep fs plan.GlobalU32Inputs plan.GlobalInputs
            reduce plan.Clocked step
            reduce plan.Ordered step
            tick <- numStep

        tick

    let private runStepsWithInputs (fs: FastSimulation) (plan: RunPlan) (fromTick: int) (target: int) =
        let maxArraySize = fs.MaxArraySize
        let mutable tick = fromTick
        let mutable simStep = fromTick % maxArraySize

        while tick < target do
            let numStep = tick + 1
            let simStepOld = simStep
            simStep <- simStep + 1

            if simStep = maxArraySize then
                simStep <- 0

            let step =
                { NumStep = numStep
                  SimStep = simStep
                  SimStepOld = simStepOld }

            propagateInputs step.SimStep fs plan.GlobalU32Inputs plan.GlobalInputs
            applyRecordedInputs numStep fs
            reduce plan.Clocked step
            reduce plan.Ordered step
            tick <- numStep

        tick

    let private runRange (fs: FastSimulation) (plan: RunPlan) (fromTick: int) (target: int) =
        if Map.isEmpty inputEvents then
            runSteps fs plan fromTick target
        else
            runStepsWithInputs fs plan fromTick target

    // The desktop runner uses a 1,000-evaluation polling budget because its caller shares the
    // thread with the UI. This runner is inside a dedicated Worker, so retaining that tiny budget
    // makes a large design pay for a clock read on almost every cycle. A 100,000-evaluation batch
    // still bounds a timed request, while avoiding a high-frequency scheduler in the hot path.
    let private cyclesBetweenClockReads (fs: FastSimulation) =
        let components = max 1 fs.FCompsByIndex.Length
        max 1 (100_000 / components)

    let private runCore (timeout: float option) (lastStepNeeded: int) (fs: FastSimulation) : RunOutcome =
        if fs.MaxArraySize = 0 then
            failwithf "ERROR: can't run a fast simulation with 0 length arrays!"

        if fs.ClockTick - lastStepNeeded >= fs.MaxArraySize then
            restartSimulation fs (planFor fs)

        if fs.ClockTick >= lastStepNeeded then
            RunCompleted
        else
            let plan = planFor fs
            let mutable tick = fs.ClockTick

            match timeout with
            | None ->
                // Benchmark and digest-style calls do not need a progress polling boundary.
                tick <- runRange fs plan tick lastStepNeeded
            | Some budget ->
                let deadline = getTimeMs () + budget
                let cyclesPerRead = cyclesBetweenClockReads fs
                let mutable outOfTime = false

                while not outOfTime && tick < lastStepNeeded do
                    let until = min lastStepNeeded (tick + cyclesPerRead)
                    tick <- runRange fs plan tick until
                    SimLog.sampleCore ()
                    outOfTime <- getTimeMs () > deadline

            fs.ClockTick <- tick

            if tick >= lastStepNeeded then
                RunCompleted
            else
                RunStoppedAt tick

    let run (timeout: float option) (lastStepNeeded: int) (fs: FastSimulation) : RunOutcome =
        runCore timeout lastStepNeeded fs

    /// Make a cycle range readable from the bounded circular history. Replaying happens inside the
    /// Worker, so a backward wave scroll does not allocate the configured run or touch the UI
    /// thread. A request wider than the retained history is rejected because no circular buffer can
    /// answer both ends after the run; normal waveform windows are much smaller than this limit.
    let ensureRange (fs: FastSimulation) (startCycle: int) (lastCycle: int) : Result<unit, string> =
        if startCycle < 0 || lastCycle < startCycle then
            Error $"invalid read range {startCycle}..{lastCycle}"
        elif lastCycle - startCycle >= fs.MaxArraySize then
            Error $"read range {startCycle}..{lastCycle} exceeds the {fs.MaxArraySize}-cycle Web history"
        else
            let plan = planFor fs
            let firstValid = max 0 (fs.ClockTick - fs.MaxArraySize + 1)

            if startCycle < firstValid then
                restartSimulation fs plan

            match runCore None lastCycle fs with
            | RunCompleted -> Ok()
            | RunStoppedAt reached -> Error $"simulation stopped at cycle {reached} while preparing a read"
