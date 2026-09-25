import SceneKit

/// Shader modifiers that animate fish (body and fins).
enum FishShaders {
    /// Bends a fish sideways in a travelling wave that grows toward the tail.
    /// Must stay in sync with `FishRig.lateralOffset(atX:)`.
    static let swim = """
    #pragma arguments
    float swimFreq;
    float swimOffset;
    float swimAmp;
    float swimBend;
    float noseX;
    float bodyLen;
    #pragma body
    // The tail-beat phase runs on the GPU; the CPU only adjusts frequency/offset/amplitude when
    // the fish's rhythm changes (see `FishRig.updateSwimRhythm`). `swimBend` curves the whole body
    // into an arc while turning.
    float swimPhase = scn_frame.time * swimFreq + swimOffset;
    float s = max(0.0, (noseX - _geometry.position.x) / bodyLen);
    float env = swimAmp * (0.08 + s * s);
    float k = 3.2;
    float wave = swimPhase - s * k;
    float off = env * sin(wave) + swimBend * s * s;
    float dOffDs = swimAmp * 2.0 * s * sin(wave) - env * k * cos(wave) + swimBend * 2.0 * s;
    float slope = -dOffDs / bodyLen;
    _geometry.position.z += off;
    _geometry.normal = normalize(float3(_geometry.normal.x - slope * _geometry.normal.z,
                                        _geometry.normal.y, _geometry.normal.z));
    """
}
