namespace Issie.Sidecar.Wasm

#nowarn "9"

open Microsoft.FSharp.NativeInterop
open System
open System.Collections.Generic
open System.Runtime.CompilerServices
open System.Runtime.InteropServices
open CommonTypes
open SimTypes
open NumberHelpers
open EvalKernel

/// A browser-only reducer table. The upstream fast simulator binds one F# closure per component.
/// That is excellent input for the desktop JIT, but every call is an indirect call in WASM AOT.
/// This table keeps the same step arrays and component semantics while making the dispatch a
/// direct static function over a small value type. Unsupported components retain the upstream
/// reducer as a safe fallback.
module internal WasmReducers =

    [<Struct>]
    type Region =
        { A: nativeptr<uint32> }

    [<Struct>]
    type Slice =
        { Shift: int
          Mask: uint32 }

    type Reducer =
        | Noop
        | Copy of Region * Region
        | Input of FastComponent * Region * Region
        | Const of Region * uint32
        | InvertBit of Region * Region
        | InvertMasked of Region * Region * uint32
        | Spread of Region * Region * uint32
        | GateAnd of Region array * Region
        | GateOr of Region array * Region
        | GateXor of Region array * Region
        | GateNand of Region array * Region
        | GateNor of Region array * Region
        | GateXnor of Region array * Region
        | Mux of Region array * Region * Region
        | Demux of Region * Region * Region array
        | Selection of Region * Region * int * uint32
        | Compare of Region * Region * uint32
        | Merge2 of Region * Region * Region * int
        | Split2 of Region * Region * Region * Slice * Slice
        | MergeMany of Region array * int array * Region
        | SplitMany of Region * Region array * Slice array
        | BinaryAnd of Region * Region * Region
        | BinaryOr of Region * Region * Region
        | BinaryXor of Region * Region * Region
        | MultiplyOp of Region * Region * Region * uint32
        | Adder of bool * bool * Region * Region * Region * Region * Region * int * uint32
        | ClockedCopy of Region * Region
        | EnabledCopy of Region * Region * Region
        | CounterOp of int * bool * bool * Region * Region * Region * Region
        | ShiftOp of int * ShiftComponentType * Region * Region * Region * uint32
        | Rom of bool * Region * Region * uint32 array
        | Fallback of (StepIndex -> unit)

    type private PinSet =
        { Handles: ResizeArray<GCHandle>
          Pointers: Dictionary<uint32 array, nativeptr<uint32>> }

    let mutable private pins =
        { Handles = ResizeArray()
          Pointers = Dictionary() }

    let resetPins () =
        for handle in pins.Handles do
            if handle.IsAllocated then
                handle.Free()

        pins.Handles.Clear()
        pins.Pointers.Clear()

    let private pointerFor (slab: uint32 array) : nativeptr<uint32> =
        match pins.Pointers.TryGetValue slab with
        | true, pointer -> pointer
        | false, _ ->
            let handle = GCHandle.Alloc(slab, GCHandleType.Pinned)
            let pointer = NativePtr.ofNativeInt (handle.AddrOfPinnedObject())
            pins.Handles.Add handle
            pins.Pointers.Add(slab, pointer)
            pointer

    let inline private getArray (arr: 'a array) (index: int) : 'a =
        Unsafe.Add(&MemoryMarshal.GetArrayDataReference(arr), index)

    let inline private setArray (arr: 'a array) (index: int) (value: 'a) =
        Unsafe.Add(&MemoryMarshal.GetArrayDataReference(arr), index) <- value

    let inline private getR (region: Region) (step: int) : uint32 =
        NativePtr.get region.A step

    let inline private setR (region: Region) (step: int) (value: uint32) =
        NativePtr.set region.A step value

    let inline copyRegion (region: Region) (targetStep: int) (sourceStep: int) =
        setR region targetStep (getR region sourceStep)

    let inline writeRegion (region: Region) (step: int) (value: uint32) =
        setR region step value

    let inline private oldR (region: Region) (step: StepIndex) =
        if step.NumStep = 0 then 0u else getR region step.SimStepOld

    let regionFor (io: IOArray) : Region =
        { A = NativePtr.add (pointerFor io.UInt32Slab) io.StepBase }

    let inline private inU (fc: FastComponent) (index: int) = regionFor fc.InputLinks[index]
    let inline private outU (fc: FastComponent) (index: int) = regionFor fc.Outputs[index]

    let private noRegion =
        { A = NativePtr.ofNativeInt IntPtr.Zero }

    let inline private maskOf (width: int) =
        if width = 32 then 0xFFFFFFFFu else (1u <<< width) - 1u

    let inline private sliceOf (msb: int) (lsb: int) =
        { Shift = lsb
          Mask = maskOf (msb - lsb + 1) }

    let private romTable (mem: Memory1) : uint32 array =
        let table = Array.zeroCreate<uint32> (1 <<< mem.AddressWidth)

        mem.Data
        |> Map.iter (fun address value ->
            if address >= 0I && address < bigint table.Length then
                table[int address] <- convertBigintToUInt32 mem.WordWidth value)

        table

    let inline private reduceGateAnd (inputs: Region array) (dst: Region) (s: int) (negated: bool) =
        let mutable i = 1
        let mutable value = getR (getArray inputs 0) s

        while i < inputs.Length do
            value <- value &&& getR (getArray inputs i) s
            i <- i + 1

        setR dst s (if negated then value ^^^ 1u else value)

    let inline private reduceGateOr (inputs: Region array) (dst: Region) (s: int) (negated: bool) =
        let mutable i = 1
        let mutable value = getR (getArray inputs 0) s

        while i < inputs.Length do
            value <- value ||| getR (getArray inputs i) s
            i <- i + 1

        setR dst s (if negated then value ^^^ 1u else value)

    let inline private reduceGateXor (inputs: Region array) (dst: Region) (s: int) (negated: bool) =
        let mutable i = 1
        let mutable value = getR (getArray inputs 0) s

        while i < inputs.Length do
            value <- value ^^^ getR (getArray inputs i) s
            i <- i + 1

        setR dst s (if negated then value ^^^ 1u else value)

    let inline run (code: Reducer) (step: StepIndex) =
        let s = step.SimStep

        match code with
        | Noop -> ()
        | Copy(src, dst) -> setR dst s (getR src s)
        | Input(fc, src, dst) ->
            if fc.Active then
                setR dst s (getR src s)
        | Const(dst, value) -> setR dst s value
        | InvertBit(src, dst) -> setR dst s (getR src s ^^^ 1u)
        | InvertMasked(src, dst, mask) -> setR dst s (~~~(getR src s) &&& mask)
        | Spread(src, dst, allOnes) -> setR dst s (if getR src s = 0u then 0u else allOnes)
        | GateAnd(inputs, dst) -> reduceGateAnd inputs dst s false
        | GateOr(inputs, dst) -> reduceGateOr inputs dst s false
        | GateXor(inputs, dst) -> reduceGateXor inputs dst s false
        | GateNand(inputs, dst) -> reduceGateAnd inputs dst s true
        | GateNor(inputs, dst) -> reduceGateOr inputs dst s true
        | GateXnor(inputs, dst) -> reduceGateXor inputs dst s true
        | Mux(inputs, select, dst) -> setR dst s (getR (getArray inputs (int (getR select s))) s)
        | Demux(src, select, outputs) ->
            let selected = int (getR select s)
            let value = getR src s
            let mutable i = 0

            while i < outputs.Length do
                setR (getArray outputs i) s (if i = selected then value else 0u)
                i <- i + 1
        | Selection(src, dst, shift, mask) -> setR dst s ((getR src s >>> shift) &&& mask)
        | Compare(src, dst, target) -> setR dst s (if getR src s = target then 1u else 0u)
        | Merge2(a, b, dst, shift) -> setR dst s ((getR b s <<< shift) ||| getR a s)
        | Split2(src, out0, out1, slice0, slice1) ->
            let value = getR src s
            setR out0 s ((value >>> slice0.Shift) &&& slice0.Mask)
            setR out1 s ((value >>> slice1.Shift) &&& slice1.Mask)
        | MergeMany(inputs, widths, dst) ->
            let mutable value = 0u
            let mutable i = inputs.Length - 1

            while i >= 0 do
                value <- (value <<< getArray widths i) ||| getR (getArray inputs i) s
                i <- i - 1

            setR dst s value
        | SplitMany(src, outputs, slices) ->
            let value = getR src s
            let mutable i = 0

            while i < outputs.Length do
                let slice = getArray slices i
                setR (getArray outputs i) s ((value >>> slice.Shift) &&& slice.Mask)
                i <- i + 1
        | BinaryAnd(a, b, dst) -> setR dst s (getR a s &&& getR b s)
        | BinaryOr(a, b, dst) -> setR dst s (getR a s ||| getR b s)
        | BinaryXor(a, b, dst) -> setR dst s (getR a s ^^^ getR b s)
        | MultiplyOp(a, b, dst, mask) -> setR dst s ((getR a s * getR b s) &&& mask)
        | Adder(hasCin, hasCout, cin, a, b, sumOut, coutOut, width, mask) ->
            if width = 32 then
                let carryIn = if hasCin then uint64 (getR cin s &&& 1u) else 0UL
                let total = uint64 (getR a s) + uint64 (getR b s) + carryIn
                setR sumOut s (uint32 total)

                if hasCout then
                    setR coutOut s (uint32 (total >>> 32) &&& 1u)
            else
                let carryIn = if hasCin then getR cin s &&& 1u else 0u
                let total = getR a s + getR b s + carryIn
                setR sumOut s (total &&& mask)

                if hasCout then
                    setR coutOut s ((total >>> width) &&& 1u)
        | ClockedCopy(src, dst) -> setR dst s (oldR src step)
        | EnabledCopy(src, enable, dst) ->
            setR dst s (if oldR enable step = 1u then oldR src step else oldR dst step)
        | CounterOp(width, hasLoad, hasEnable, loadData, load, enable, dst) ->
            let lastOut = oldR dst step
            let value =
                if hasEnable && oldR enable step <> 1u then
                    lastOut
                elif hasLoad && oldR load step = 1u then
                    oldR loadData step
                else
                    incrementWithinWidth width lastOut

            setR dst s value
        | ShiftOp(width, shiftType, src, amount, dst, mask) ->
            let bits = getR src s &&& mask
            let shiftAmount = getR amount s

            let value =
                match shiftType with
                | LSL ->
                    if shiftAmount >= uint32 width then 0u else (bits <<< int shiftAmount) &&& mask
                | LSR ->
                    if shiftAmount >= uint32 width then 0u else bits >>> int shiftAmount
                | ASR ->
                    let signSet = (bits >>> (width - 1)) &&& 1u = 1u

                    if shiftAmount = 0u then
                        bits
                    elif shiftAmount >= uint32 width then
                        if signSet then mask else 0u
                    elif signSet then
                        let amount = int shiftAmount
                        (bits >>> amount) ||| (mask &&& (mask <<< (width - amount)))
                    else
                        bits >>> int shiftAmount

            setR dst s value
        | Rom(synchronous, src, dst, table) ->
            let address = if synchronous then oldR src step else getR src s
            setR dst s (getArray table (int address))
        | Fallback fallback -> fallback step

    let private directCodeFor (fc: FastComponent) : Reducer option =
        match fc.FType, fc.UseBigInt with
        | IOLabel, false
        | Output _, false
        | Viewer _, false -> Some(Copy(inU fc 0, outU fc 0))
        | Input1 _, false -> Some(Input(fc, inU fc 0, outU fc 0))
        | NotConnected, _ -> Some Noop
        | Constant1(width, value, _), false
        | Constant(width, value), false -> Some(Const(outU fc 0, uint32 (twosComp width value)))
        | Not, false -> Some(InvertBit(inU fc 0, outU fc 0))
        | GateN(gateType, numberOfInputs), false ->
            let inputs = Array.init numberOfInputs (inU fc)
            let output = outU fc 0

            match gateType with
            | And -> Some(GateAnd(inputs, output))
            | Or -> Some(GateOr(inputs, output))
            | Xor -> Some(GateXor(inputs, output))
            | Nand -> Some(GateNand(inputs, output))
            | Nor -> Some(GateNor(inputs, output))
            | Xnor -> Some(GateXnor(inputs, output))
        | Mux2, false -> Some(Mux(Array.init 2 (inU fc), inU fc 2, outU fc 0))
        | Mux4, false -> Some(Mux(Array.init 4 (inU fc), inU fc 4, outU fc 0))
        | Mux8, false -> Some(Mux(Array.init 8 (inU fc), inU fc 8, outU fc 0))
        | Demux2, false -> Some(Demux(inU fc 0, inU fc 1, Array.init 2 (outU fc)))
        | Demux4, false -> Some(Demux(inU fc 0, inU fc 1, Array.init 4 (outU fc)))
        | Demux8, false -> Some(Demux(inU fc 0, inU fc 1, Array.init 8 (outU fc)))
        | BusSelection(width, lsb), false ->
            let slice = sliceOf (lsb + width - 1) lsb
            Some(Selection(inU fc 0, outU fc 0, slice.Shift, slice.Mask))
        | BusCompare(_, compareValue), false
        | BusCompare1(_, compareValue, _), false ->
            if compareValue >= 0I && compareValue <= 4294967295I then
                Some(Compare(inU fc 0, outU fc 0, uint32 compareValue))
            else
                Some(Const(outU fc 0, 0u))
        | MergeWires, false -> Some(Merge2(inU fc 0, inU fc 1, outU fc 0, fc.InputWidth 0))
        | MergeN 2, false -> Some(Merge2(inU fc 0, inU fc 1, outU fc 0, fc.InputWidth 0))
        | SplitWire topWidth, false ->
            Some(
                Split2(
                    inU fc 0,
                    outU fc 0,
                    outU fc 1,
                    sliceOf (topWidth - 1) 0,
                    sliceOf (fc.InputWidth 0 - 1) topWidth
                )
            )
        | SplitN(2, [ width0; width1 ], [ lsb0; lsb1 ]), false ->
            Some(
                Split2(
                    inU fc 0,
                    outU fc 0,
                    outU fc 1,
                    sliceOf (width0 + lsb0 - 1) lsb0,
                    sliceOf (width1 + lsb1 - 1) lsb1
                )
            )
        | MergeN numberOfInputs, false ->
            Some(
                    MergeMany(
                    Array.init numberOfInputs (inU fc),
                    Array.init numberOfInputs fc.InputWidth,
                    outU fc 0
                )
            )
        | SplitN(numberOfOutputs, outputWidths, lsbBits), false ->
            Some(
                SplitMany(
                    inU fc 0,
                    Array.init numberOfOutputs (outU fc),
                    List.map2 (fun width lsb -> sliceOf (width + lsb - 1) lsb) outputWidths lsbBits
                    |> Array.ofList
                )
            )
        | NbitSpreader numberOfBits, false -> Some(Spread(inU fc 0, outU fc 0, maskOf numberOfBits))
        | NbitsAnd _, false -> Some(BinaryAnd(inU fc 0, inU fc 1, outU fc 0))
        | NbitsOr _, false -> Some(BinaryOr(inU fc 0, inU fc 1, outU fc 0))
        | NbitsXor(_, None), false -> Some(BinaryXor(inU fc 0, inU fc 1, outU fc 0))
        | NbitsXor(width, Some Multiply), false -> Some(MultiplyOp(inU fc 0, inU fc 1, outU fc 0, maskOf width))
        | NbitsNot(width), false -> Some(InvertMasked(inU fc 0, outU fc 0, maskOf width))
        | NbitsAdder width, false ->
            Some(Adder(true, true, inU fc 0, inU fc 1, inU fc 2, outU fc 0, outU fc 1, width, maskOf width))
        | NbitsAdderNoCout width, false ->
            Some(Adder(true, false, inU fc 0, inU fc 1, inU fc 2, outU fc 0, noRegion, width, maskOf width))
        | NbitsAdderNoCin width, false ->
            Some(Adder(false, true, noRegion, inU fc 0, inU fc 1, outU fc 0, outU fc 1, width, maskOf width))
        | NbitsAdderNoCinCout width, false ->
            Some(Adder(false, false, noRegion, inU fc 0, inU fc 1, outU fc 0, noRegion, width, maskOf width))
        | DFF, false
        | Register _, false -> Some(ClockedCopy(inU fc 0, outU fc 0))
        | DFFE, false
        | RegisterE _, false -> Some(EnabledCopy(inU fc 0, inU fc 1, outU fc 0))
        | Counter width, false -> Some(CounterOp(width, true, true, inU fc 0, inU fc 1, inU fc 2, outU fc 0))
        | CounterNoEnable width, false -> Some(CounterOp(width, true, false, inU fc 0, inU fc 1, noRegion, outU fc 0))
        | CounterNoLoad width, false -> Some(CounterOp(width, false, true, noRegion, noRegion, inU fc 0, outU fc 0))
        | CounterNoEnableLoad width, false ->
            Some(CounterOp(width, false, false, noRegion, noRegion, noRegion, outU fc 0))
        | Shift(width, _, shiftType), false ->
            Some(ShiftOp(width, shiftType, inU fc 0, inU fc 1, outU fc 0, maskOf width))
        | AsyncROM1 mem, false when mem.AddressWidth <= 16 ->
            Some(Rom(false, inU fc 0, outU fc 0, romTable mem))
        | ROM1 mem, false when mem.AddressWidth <= 16 ->
            Some(Rom(true, inU fc 0, outU fc 0, romTable mem))
        | _ -> None

    let create (fc: FastComponent) (fallback: StepIndex -> unit) : Reducer =
        match directCodeFor fc with
        | Some code -> code
        | None -> Fallback fallback
