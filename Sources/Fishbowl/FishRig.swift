import SceneKit
import simd

/// Everything that draws and animates one fish: its nodes, its private materials, the swim wave
/// (tail-beat rhythm and turn bend) sent to the shaders, its eyes and, for the shark, its jaw.
/// `Fish` decides where to go and how fast; the rig makes it look alive.
final class FishRig {
    let node = SCNNode()
    let model: FishModel
    /// Body and fin materials: each has the swim modifier and its own swim uniforms.
    let materials: [SCNMaterial]
    let eyes: EyeRig

    // MARK: Hooks for behaviour

    /// 0 = gliding (tail held still), 1 = swimming normally. Set by `Fish` each frame.
    var thrust: Float = 1
    /// 0 = shut, 1 = gaping wide (shark only).
    var mouthOpen: Float = 0

    /// A sudden sideways curl of the whole body, e.g. the C-shaped start of an escape.
    /// `amount` is in body lengths at the tail; the sign picks the side.
    func curl(_ amount: Float) {
        targetBend += amount * model.length
    }

    /// The fish just ate something.
    func gulp() {}

    // MARK: State

    // Swim rhythm as last sent to the shader: phase(t) = swimFreq * t + swimOffset.
    private var swimFreq: Float = 0
    private var swimOffset = rnd(0...(2 * .pi))
    private var swimAmp: Float = 0
    private var smoothedAmp: Float = 0
    private var sinceRhythmUpdate: Float = 1
    /// Sideways curve of the body while turning (world units at the tail joint), as sent / as wanted.
    private var swimBend: Float = 0
    private var targetBend: Float = 0
    private var sinceBendUpdate: Float = 1
    private var renderTime: Float = 0
    private var causticScale: Float = 1

    // Shark jaw.
    private var jawPivot: SCNNode?
    private var upperTeeth: SCNNode?
    private var palate: SCNNode?
    private var lowerTeeth: SCNNode?

    init(model: FishModel, size: Float) {
        self.model = model
        func instance(_ g: SCNGeometry) -> (SCNNode, SCNMaterial) {
            let copy = g.copy() as! SCNGeometry
            let mat = g.firstMaterial!.copy() as! SCNMaterial
            mat.setValue(model.noseX, forKey: "noseX")
            mat.setValue(model.length, forKey: "bodyLen")
            copy.materials = [mat]
            return (SCNNode(geometry: copy), mat)
        }
        let (bodyNode, bodyMat) = instance(model.body)
        let (finNode, finMat) = instance(model.fins)
        finNode.castsShadow = false
        materials = [bodyMat, finMat]
        FishMaterials.personalize(bodyMat, species: model.species)
        node.addChildNode(bodyNode)
        node.addChildNode(finNode)
        eyes = EyeRig(model: model.eyes, parent: node)

        if let jaw = model.jaw {
            let pivot = SCNNode()
            pivot.simdPosition = jaw.hinge
            let shell = SCNNode(geometry: jaw.shell)
            shell.simdPosition = -jaw.hinge
            let lower = SCNNode(geometry: jaw.lowerTeeth)
            lower.simdPosition = -jaw.hinge
            pivot.addChildNode(shell)
            pivot.addChildNode(lower)
            node.addChildNode(pivot)
            let upper = SCNNode(geometry: jaw.upperTeeth)
            node.addChildNode(upper)
            let roof = SCNNode(geometry: jaw.palate)
            node.addChildNode(roof)
            [shell, lower, upper, roof].forEach { $0.castsShadow = false }
            jawPivot = pivot
            upperTeeth = upper
            lowerTeeth = lower
            palate = roof
        }

        node.simdScale = V3(repeating: size)
        for mat in materials {
            mat.setValue(swimFreq, forKey: "swimFreq")
            mat.setValue(swimOffset, forKey: "swimOffset")
            mat.setValue(swimAmp, forKey: "swimAmp")
            mat.setValue(swimBend, forKey: "swimBend")
        }
    }

    // MARK: Per frame

    /// Update the animation for this frame. `turnRate` is how fast the body is actually rotating
    /// (radians/s, positive = turning toward -z in fish space); `excitement` is 0 calm ... 1 panicked.
    func animate(dt: Float, fish: Fish, speed: Float, cruise: Float, excitement: Float, turnRate: Float, tank: Tank) {
        renderTime = tank.renderTime

        // Flex into the turn: the body arcs with the tail swinging toward the inside of the curve.
        let flex = Float(model.species.flex)
        let maxBend = model.length * 0.3 * min(flex, 1.5)
        let bendGoal = clamp(-turnRate * model.length * 0.12 * flex, -maxBend, maxBend)
        targetBend += (bendGoal - targetBend) * min(1, dt * 6)
        updateBend(dt: dt)

        // Faster, bigger tail beats at speed.
        let hz = min(8, 1.1 + (speed / Fish.speedUnit) / (Float(model.species.length) * 0.9))
        let targetAmp = model.length * (0.035 + 0.05 * min(1, speed / (cruise * 2)) + 0.03 * excitement)
        smoothedAmp += (targetAmp - smoothedAmp) * min(1, dt * 3)
        updateSwimRhythm(hz: hz, dt: dt)

        eyes.update(dt: dt, fish: fish, tank: tank, lateral: lateralOffset(atX: model.eyes.x))
        updateJaw()
    }

    /// Fish get no caustics or fin glow at night; only touched when the day/night blend steps.
    func setCausticScale(_ scale: Float) {
        guard scale != causticScale else { return }
        causticScale = scale
        materials[0].setValue(0.35 * scale, forKey: "causticStrength")
        materials[1].emission.intensity = CGFloat(0.25 * scale)
    }

    /// Same wave as `FishShaders.swim`, so rigid parts (eyes, jaw) follow the body.
    func lateralOffset(atX x: Float) -> Float {
        let s = max(0, (model.noseX - x) / model.length)
        let phase = swimFreq * renderTime + swimOffset
        return swimAmp * (0.08 + s * s) * sin(phase - s * 3.2) + swimBend * s * s
    }

    // MARK: Shader uniforms

    /// Setting shader values is expensive in SceneKit, so the tail-beat phase runs on the GPU and we
    /// only send a new frequency/amplitude when the rhythm has changed noticeably (at most ~6x/s).
    private func updateSwimRhythm(hz: Float, dt: Float) {
        sinceRhythmUpdate += dt
        let freq = Shaders.quantize(hz * 2 * .pi)
        let freqChanged = abs(freq - swimFreq) > swimFreq * 0.12
        let ampChanged = abs(smoothedAmp - swimAmp) > swimAmp * 0.12 + model.length * 0.002
        guard sinceRhythmUpdate > 0.16, freqChanged || ampChanged else { return }
        sinceRhythmUpdate = 0
        if freqChanged {
            // Keep the phase continuous at the moment of the switch.
            let t = renderTime
            swimOffset = (swimFreq * t + swimOffset - freq * t).truncatingRemainder(dividingBy: 2 * .pi)
            swimFreq = freq
            for mat in materials {
                mat.setValue(swimFreq, forKey: "swimFreq")
                mat.setValue(swimOffset, forKey: "swimOffset")
            }
        }
        if ampChanged {
            swimAmp = smoothedAmp
            for mat in materials { mat.setValue(swimAmp, forKey: "swimAmp") }
        }
    }

    /// Like the rhythm, the bend is only sent to the shader when it has changed noticeably.
    private func updateBend(dt: Float) {
        sinceBendUpdate += dt
        guard sinceBendUpdate > 0.08, abs(targetBend - swimBend) > model.length * 0.015 else { return }
        sinceBendUpdate = 0
        swimBend = abs(targetBend) < model.length * 0.01 ? 0 : targetBend
        for mat in materials { mat.setValue(swimBend, forKey: "swimBend") }
    }

    private func updateJaw() {
        guard let jaw = model.jaw, let pivot = jawPivot else { return }
        let lateral = V3(0, 0, lateralOffset(atX: jaw.midX))
        pivot.simdPosition = jaw.hinge + lateral
        // The lower jaw drops, front first, about the hinge at the back of the mouth.
        pivot.simdEulerAngles = V3(0, 0, -0.75 * mouthOpen)
        upperTeeth?.simdPosition = lateral
        palate?.simdPosition = lateral
        // The inside of the mouth only exists while it's open.
        let shut = mouthOpen < 0.03
        upperTeeth?.isHidden = shut
        lowerTeeth?.isHidden = shut
        palate?.isHidden = shut
    }
}
