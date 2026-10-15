import AudioToolbox
import CoreAudio
import Foundation

/// Lists CoreAudio devices so the menu can pick VisionCLI's microphone and speaker
/// (app-only: the Mac's system default devices are left alone).
struct AudioDevice {
    let id: AudioDeviceID
    let uid: String
    let name: String
    let inputChannels: Int
    let outputChannels: Int
}

enum AudioDevices {
    private static func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func all() -> [AudioDevice] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            guard let uid = string(id, kAudioDevicePropertyDeviceUID), let name = string(id, kAudioObjectPropertyName) else { return nil }
            return AudioDevice(id: id, uid: uid, name: name,
                               inputChannels: channels(id, kAudioObjectPropertyScopeInput),
                               outputChannels: channels(id, kAudioObjectPropertyScopeOutput))
        }
    }

    /// Keep the device list live. By default CoreAudio only refreshes it for processes that receive HAL
    /// notifications, so without this, headphones/AirPods plugged in after launch never show up.
    static func startMonitoring(_ onChange: @escaping () -> Void) {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var runLoopAddr = address(kAudioHardwarePropertyRunLoop)
        var runLoop: CFRunLoop? = nil // nil = let the HAL deliver notifications on its own thread
        AudioObjectSetPropertyData(system, &runLoopAddr, 0, nil, UInt32(MemoryLayout<CFRunLoop?>.size), &runLoop)
        for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice] {
            var addr = address(selector)
            AudioObjectAddPropertyListenerBlock(system, &addr, DispatchQueue.main) { _, _ in onChange() }
        }
    }

    static var inputs: [AudioDevice] { all().filter { $0.inputChannels > 0 } }
    static var outputs: [AudioDevice] { all().filter { $0.outputChannels > 0 } }

    static func defaultDevice(input: Bool) -> AudioDevice? {
        var addr = address(input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr else { return nil }
        return all().first { $0.id == id }
    }

    static func device(uid: String) -> AudioDevice? { all().first { $0.uid == uid } }

    private static func transport(_ id: AudioDeviceID) -> UInt32 {
        var addr = address(kAudioDevicePropertyTransportType)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr ? value : 0
    }

    /// A Bluetooth headset: opening its microphone switches it to the low-quality call profile.
    static func isBluetooth(_ d: AudioDevice) -> Bool {
        [kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE].contains(transport(d.id))
    }

    /// The Mac's own microphone, if it has one.
    static var builtInInput: AudioDevice? { inputs.first { transport($0.id) == kAudioDeviceTransportTypeBuiltIn } }

    private static func string(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let v = value else { return nil }
        return v.takeRetainedValue() as String
    }

    private static func channels(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
        var addr = address(kAudioDevicePropertyStreamConfiguration, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, list) == noErr else { return 0 }
        return UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + Int($1.mNumberChannels) }
    }
}
