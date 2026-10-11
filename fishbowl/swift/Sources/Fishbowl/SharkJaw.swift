import SceneKit
import simd

/// The shark's articulated mouth: a lower jaw cut from the underside of the head that swings open
/// on a hinge at the back of the mouth, a dark mouth interior, and rows of teeth on both jaws.
///
/// Built in the shark's model space. The jaw's outer surface follows the head just outside the
/// body, so it looks seamless when shut. The dark roof of the mouth is a separate thin piece between
/// the body and the jaw; like the teeth it is hidden while the mouth is shut, so a flexing body can
/// never show a dark edge along a closed mouth.
struct SharkJaw {
    /// The mouth runs from this far behind the nose (the hinge)...
    static let backFraction: CGFloat = 0.27
    /// ...to this far behind it (the snout overhangs the front of the jaw).
    static let frontFraction: CGFloat = 0.045
    /// How far round the underside the jaw reaches on each side (radians from straight down).
    static let spread: Float = 1.05

    let shell: SCNGeometry
    let lowerTeeth: SCNGeometry
    let upperTeeth: SCNGeometry
    /// The roof of the mouth (moves with the head).
    let palate: SCNGeometry
    /// Hinge position in model space (world units, before per-fish scale).
    let hinge: V3
    /// Model-space x of the middle of the mouth, for following the swim wave.
    let midX: Float

    /// Skin, mouth interior, gums, teeth, and the lip edge (a soft grey crease when the mouth is shut).
    private static let palette = [RGBA(0.94, 0.94, 0.92), RGBA(0.28, 0.05, 0.07), RGBA(0.55, 0.20, 0.22),
                                  RGBA(0.97, 0.96, 0.91), RGBA(0.42, 0.45, 0.49)]
    private enum Tone: Int { case skin, mouth, gum, tooth, lip }

    /// `section(x)` gives the body's half-height and half-width at x (species points).
    init(species s: Species, unit u: Float, section: (Float) -> (hy: Float, hz: Float)) {
        let a = Float(s.length / 2), L = Float(s.length)
        let xh = a - Float(SharkJaw.backFraction) * L, xf = a - Float(SharkJaw.frontFraction) * L
        let phi = SharkJaw.spread
        let nx = 12, na = 14
        func uv(_ t: Tone) -> V2 { Art.paletteUV(t.rawValue, of: SharkJaw.palette.count) }
        func point(_ x: Float, _ th: Float, _ scale: Float) -> V3 {
            let (hy, hz) = section(x)
            return V3(x, hy * cos(th) * scale, hz * sin(th) * scale)
        }
        func xAt(_ i: Int) -> Float { xh + (xf - xh) * Float(i) / Float(nx) }
        func thAt(_ j: Int) -> Float { .pi - phi + 2 * phi * Float(j) / Float(na) }

        // Jaw shell: outer skin just outside the body, dark inner surface, lips joining them.
        var shell = Mesh()
        func grid(scale: Float, tone: Tone, flip: Bool) {
            let base = shell.positions.count
            for i in 0...nx {
                for j in 0...na {
                    shell.positions.append(point(xAt(i), thAt(j), scale))
                    shell.uvs.append(uv(tone))
                }
            }
            for i in 0..<nx {
                for j in 0..<na {
                    let a0 = base + i * (na + 1) + j, b0 = a0 + 1, c0 = a0 + na + 1, d0 = c0 + 1
                    if flip { shell.quad(b0, a0, d0, c0) } else { shell.quad(a0, b0, c0, d0) }
                }
            }
        }
        grid(scale: 1.02, tone: .skin, flip: false)
        grid(scale: 0.95, tone: .mouth, flip: true)
        let jawShell = shell
        shell = Mesh()
        grid(scale: 1.008, tone: .mouth, flip: false)
        var palate = shell
        shell = jawShell
        func lip(_ edge: [(Float, Float)]) {
            let base = shell.positions.count
            for (x, th) in edge {
                shell.positions += [point(x, th, 1.02), point(x, th, 0.95)]
                shell.uvs += [uv(.lip), uv(.gum)]
            }
            for k in 0..<(edge.count - 1) { shell.quad(base + k * 2, base + k * 2 + 1, base + k * 2 + 2, base + k * 2 + 3) }
        }
        lip((0...nx).map { (xAt($0), thAt(0)) })
        lip((0...nx).map { (xAt($0), thAt(na)) })
        lip((0...na).map { (xf, thAt($0)) })

        // Teeth along the rims: upward on the lower jaw, downward from the upper jaw line.
        var lower = Mesh(), upper = Mesh()
        let toothLength = L * 0.03, toothWidth = L * 0.0075
        var rim: [(x: Float, th: Float)] = []
        let sideCount = 9, frontCount = 8
        for k in 0..<sideCount {
            let x = xh + (xf - xh) * (0.25 + 0.75 * Float(k) / Float(sideCount - 1))
            rim += [(x, thAt(0)), (x, thAt(na))]
        }
        for k in 1..<frontCount {
            rim.append((xf - L * 0.004, thAt(0) + (thAt(na) - thAt(0)) * Float(k) / Float(frontCount)))
        }
        for (x, th) in rim {
            let inward = -V3(0, cos(th), sin(th))
            let jitter = rnd(0.8...1.15)
            lower.append(SharkJaw.tooth(at: point(x, th, 0.97), pointing: (V3(0, 1, 0) * 0.8 + inward * 0.4).normalized,
                                        length: toothLength * jitter, width: toothWidth, uv: uv(.tooth)))
            upper.append(SharkJaw.tooth(at: point(x - L * 0.006, th, 0.99), pointing: (V3(0, -1, 0) * 0.85 + inward * 0.3).normalized,
                                        length: toothLength * 1.1 * jitter, width: toothWidth, uv: uv(.tooth)))
        }

        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = Art.palette(SharkJaw.palette)
        mat.diffuse.magnificationFilter = .nearest
        mat.roughness.contents = 0.7
        mat.isDoubleSided = true
        func finish(_ m: inout Mesh) -> SCNGeometry {
            m.positions = m.positions.map { $0 * u }
            m.normals = []
            m.computeNormals()
            let g = m.geometry()
            g.materials = [mat]
            return g
        }
        self.shell = finish(&shell)
        lowerTeeth = finish(&lower)
        upperTeeth = finish(&upper)
        self.palate = finish(&palate)
        hinge = V3(xh, -section(xh).hy * 0.2, 0) * u
        midX = (xh + xf) / 2 * u
    }

    /// A small triangular pyramid.
    private static func tooth(at p: V3, pointing dir: V3, length: Float, width: Float, uv: V2) -> Mesh {
        let side = abs(dir.x) < 0.9 ? simd_cross(dir, V3(1, 0, 0)).normalized : simd_cross(dir, V3(0, 1, 0)).normalized
        let up = simd_cross(side, dir)
        var m = Mesh()
        for k in 0..<3 {
            let a = Float(k) / 3 * 2 * .pi
            m.positions.append(p + (side * cos(a) + up * sin(a)) * width)
        }
        m.positions.append(p + dir * length)
        m.uvs = Array(repeating: uv, count: 4)
        m.triangle(0, 1, 3)
        m.triangle(1, 2, 3)
        m.triangle(2, 0, 3)
        return m
    }
}
