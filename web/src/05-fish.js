// ---------------------------------------------------------------------------------------------
// FishRig (FishRig.swift): everything that draws and animates one fish — its nodes, its private
// materials, the swim wave sent to the shaders, its eyes and, for the shark, its jaw
// ---------------------------------------------------------------------------------------------

/** Fade a whole object (all its materials) to opacity `a`, switching to blending only while needed. */
function setObjectOpacity(obj, a) {
  obj.traverse((o) => {
    if (!o.material) return;
    const m = o.material;
    if (m.userData.baseTransparent === undefined) {
      m.userData.baseTransparent = m.transparent;
      m.userData.baseOpacity = m.opacity;
      m.userData.baseDepthWrite = m.depthWrite;
    }
    const want = m.userData.baseTransparent || a < 0.999;
    if (m.transparent !== want) { m.transparent = want; m.needsUpdate = true; }
    m.opacity = m.userData.baseOpacity * a;
  });
}

class FishRig {
  constructor(model, size) {
    this.model = model;
    this.node = new THREE.Group();
    const s = model.species;
    const shark = s.shape === 'shark';
    this.finsMove = !shark;

    // 0 = gliding, 1 = swimming normally (set by Fish each frame). Mouth: 0 shut ... 1 wide (shark).
    this.thrust = 1;
    this.mouthOpen = 0;

    // Swim rhythm as last sent to the shader: phase(t) = swimFreq * t + swimOffset.
    this.swimFreq = 0;
    this.swimOffset = rnd(0, TAU);
    this.swimAmp = 0;
    this.smoothedAmp = 0;
    this.sinceRhythmUpdate = 1;
    this.swimBend = 0;
    this.targetBend = 0;
    this.sinceBendUpdate = 1;
    this.renderTime = 0;
    this.causticScale = 1;
    // Independent fin motion: hover and brake as wanted, and as last sent.
    this.hover = 0;
    this.brake = 0;
    this.lastSpeed = 0;
    this.finFrom = new THREE.Vector2();
    this.finTo = new THREE.Vector2();
    this.finTime = -100;
    this.sinceFinUpdate = 1;
    this.glowFrom = 0;
    this.glowTo = 0;
    this.glowTime = -100;
    this.sinceGlowUpdate = 1;
    this.lampSent = false;

    const swim = {
      swimFreq: { value: 0 }, swimOffset: { value: this.swimOffset }, swimAmp: { value: 0 }, swimBend: { value: 0 },
      noseX: { value: model.noseX }, bodyLen: { value: model.length },
    };
    this.swim = swim;
    // Breathing: a slow rhythm, slower for bigger fish. The shark only flares its gill slits.
    const breathHz = (shark ? 0.3 : clamp(38 / s.length, 0.3, 1.1)) * rnd(0.85, 1.15);
    const look = FishMaterials.personalize(s, model.art.skinRect);
    this.bodyU = {
      ...swim,
      breathFreq: { value: quantize(breathHz * TAU) },
      breathPhase: { value: rnd(0, TAU) },
      mouthAmp: { value: shark ? 0 : 0.03 },
      gillAmp: { value: shark ? 0.006 : 0.03 },
      gillX: { value: shark ? 0.36 : 0.3 },
      gulpTime: { value: -1000 },
      fishLook: { value: look.fishLook },
      fishMorph: { value: look.fishMorph },
      fishPale: { value: look.fishPale },
      fishSheen: { value: new THREE.Vector4(...FishMaterials.sheen(s)) },
    };
    // Fins scull at their own pace; small fish flick them faster.
    const finHz = 110 / (s.length + 14) * rnd(0.9, 1.1);
    this.finU = {
      ...swim,
      finFreq: { value: quantize(finHz * TAU) },
      finSeed: { value: rnd(0, TAU) },
      finFrom: { value: new THREE.Vector4() },
      finTo: { value: new THREE.Vector4() },
      finTime: { value: this.finTime },
      finGlow: { value: new THREE.Vector4() },
      lampPos: { value: v3() },
    };

    const body = new THREE.Mesh(model.body, FishMaterials.body(model, this.bodyU));
    body.customDepthMaterial = FishMaterials.bodyDepth(this.bodyU);
    body.castShadow = true;
    body.receiveShadow = true;
    body.frustumCulled = false;
    const fins = new THREE.Mesh(model.fins.geometry, FishMaterials.fins(model, this.finU));
    fins.receiveShadow = true;
    fins.frustumCulled = false;
    this.node.add(body, fins);
    this.eyes = new EyeRig(model.eyes, this.node);

    if (model.jaw) {
      const jaw = model.jaw;
      const mk = (g) => new THREE.Mesh(g, jaw.material);
      const pivot = new THREE.Group();
      pivot.position.copy(jaw.hinge);
      const shell = mk(jaw.shell);
      shell.position.copy(jaw.hinge).negate();
      const lower = mk(jaw.lowerTeeth);
      lower.position.copy(jaw.hinge).negate();
      pivot.add(shell, lower);
      const upper = mk(jaw.upperTeeth);
      const roof = mk(jaw.palate);
      this.node.add(pivot, upper, roof);
      this.jawPivot = pivot;
      this.upperTeeth = upper;
      this.lowerTeeth = lower;
      this.palate = roof;
    }
    this.node.scale.setScalar(size);
  }

  /** A sudden sideways curl of the whole body, e.g. the C-shaped start of an escape. */
  curl(amount) { this.targetBend += amount * this.model.length; }

  /** The fish just ate something: the mouth gapes for a moment and the gills flare. */
  gulp() { this.bodyU.gulpTime.value = this.renderTime; }

  /** Update the animation for this frame. */
  animate(dt, fish, speed, cruise, excitement, turnRate, tank) {
    this.renderTime = tank.renderTime;
    const model = this.model;
    // Flex into the turn: the body arcs with the tail swinging toward the inside of the curve.
    const flex = model.species.flex;
    const maxBend = model.length * 0.3 * Math.min(flex, 1.5);
    const bendGoal = clamp(-turnRate * model.length * 0.12 * flex, -maxBend, maxBend);
    this.targetBend += (bendGoal - this.targetBend) * Math.min(1, dt * 6);
    this.updateBend(dt);

    // Faster, bigger tail beats at speed; the tail all but stops while gliding.
    const hz = Math.min(8, 1.1 + (speed / Fish.speedUnit) / (model.species.length * 0.9));
    const beat = 0.06 + 0.94 * clamp(this.thrust, 0, 1);
    const targetAmp = model.length * (0.035 + 0.05 * Math.min(1, speed / (cruise * 2)) + 0.03 * excitement) * beat;
    this.smoothedAmp += (targetAmp - this.smoothedAmp) * Math.min(1, dt * 3);
    this.updateSwimRhythm(hz, dt);

    // Pectorals scull hardest when hovering or gliding, and flare out to brake.
    if (this.finsMove) {
      const slow = clamp(1 - speed / cruise, 0, 1);
      this.hover += (Math.max(slow, (1 - clamp(this.thrust, 0, 1)) * 0.6) - this.hover) * Math.min(1, dt * 2);
      const decel = dt > 0 ? (this.lastSpeed - speed) / dt : 0;
      const brakeGoal = clamp((decel / cruise - 0.4) / 1.2, 0, 1);
      this.brake += (brakeGoal - this.brake) * Math.min(1, dt * (brakeGoal > this.brake ? 8 : 1.5));
      this.updateFins(dt);
      this.updateGlow(dt, fish, tank);
    }
    this.lastSpeed = speed;

    this.eyes.update(dt, fish, tank, this.lateralOffset(model.eyes.x));
    this.updateJaw();
  }

  /** Fish get no caustics at night, and their fins glow only in the lamp's beam. */
  setCausticScale(scale) {
    if (scale === this.causticScale) return;
    this.causticScale = scale;
    this.sinceGlowUpdate = Infinity;
  }

  /** Same wave as the swim shader, so rigid parts (eyes, jaw) follow the body. */
  lateralOffset(x) {
    const s = Math.max(0, (this.model.noseX - x) / this.model.length);
    const phase = this.swimFreq * this.renderTime + this.swimOffset;
    return this.swimAmp * (0.08 + s * s) * Math.sin(phase - s * 3.2) + this.swimBend * s * s;
  }

  /** The tail-beat phase runs on the GPU; only send a new frequency/amplitude when the rhythm
   *  has changed noticeably, keeping the phase continuous. */
  updateSwimRhythm(hz, dt) {
    this.sinceRhythmUpdate += dt;
    const freq = quantize(hz * TAU);
    const freqChanged = Math.abs(freq - this.swimFreq) > this.swimFreq * 0.12;
    const ampChanged = Math.abs(this.smoothedAmp - this.swimAmp) > this.swimAmp * 0.12 + this.model.length * 0.002;
    if (!(this.sinceRhythmUpdate > 0.16 && (freqChanged || ampChanged))) return;
    this.sinceRhythmUpdate = 0;
    if (freqChanged) {
      const t = this.renderTime;
      this.swimOffset = (this.swimFreq * t + this.swimOffset - freq * t) % TAU;
      this.swimFreq = freq;
      this.swim.swimFreq.value = this.swimFreq;
      this.swim.swimOffset.value = this.swimOffset;
    }
    if (ampChanged) {
      this.swimAmp = this.smoothedAmp;
      this.swim.swimAmp.value = this.swimAmp;
    }
  }

  /** Hover and brake ease on the GPU; they're only sent when they have changed noticeably. */
  updateFins(dt) {
    this.sinceFinUpdate += dt;
    const goal = new THREE.Vector2(this.hover, this.brake);
    if (!(this.sinceFinUpdate > 0.3 && goal.distanceTo(this.finTo) > 0.12)) return;
    this.sinceFinUpdate = 0;
    this.finFrom = this.eased2(this.finFrom, this.finTo, this.finTime, 0.4);
    this.finTo = goal;
    this.finTime = this.renderTime;
    this.finU.finFrom.value.set(this.finFrom.x, this.finFrom.y, 0, 0);
    this.finU.finTo.value.set(this.finTo.x, this.finTo.y, 0, 0);
    this.finU.finTime.value = this.finTime;
  }

  /** How strongly light shines through the fins: sunlight by day; at night only in the lamp's cone. */
  updateGlow(dt, fish, tank) {
    const light = tank.lighting;
    if (!this.lampSent) {
      this.lampSent = true;
      this.finU.lampPos.value.copy(light.spotPosition);
    }
    this.sinceGlowUpdate += dt;
    if (!(this.sinceGlowUpdate > 0.25)) return;
    const night = 1 - this.causticScale;
    let goal = this.causticScale;
    if (night > 0) {
      const aim = unit(light.spotTarget.clone().sub(light.spotPosition));
      const angle = Math.acos(clamp(unit(fish.pos.clone().sub(light.spotPosition)).dot(aim), -1, 1));
      const inBeam = 1 - smoothstep(light.spotHalfAngle * 0.7, light.spotHalfAngle * 1.3, angle);
      goal += night * 1.3 * inBeam;
    }
    const nightChanged = !isFinite(this.sinceGlowUpdate);
    if (!(nightChanged || Math.abs(goal - this.glowTo) > 0.1 || (goal < 0.02 && this.glowTo > 0))) return;
    this.sinceGlowUpdate = 0;
    this.glowFrom = this.eased2(new THREE.Vector2(this.glowFrom, 0), new THREE.Vector2(this.glowTo, 0), this.glowTime, 0.5).x;
    this.glowTo = goal < 0.02 ? 0 : goal;
    this.glowTime = this.renderTime;
    this.finU.finGlow.value.set(this.glowFrom, this.glowTo, this.glowTime, night);
  }

  /** Where a value easing linearly from a to b over `duration` from `start` is now, as the
   *  shaders compute it (after the hourly time wrap it counts as arrived). */
  eased2(a, b, start, duration) {
    const t = this.renderTime - start;
    return a.clone().lerp(b, t < 0 ? 1 : Math.min(1, t / duration));
  }

  updateBend(dt) {
    this.sinceBendUpdate += dt;
    if (!(this.sinceBendUpdate > 0.08 && Math.abs(this.targetBend - this.swimBend) > this.model.length * 0.015)) return;
    this.sinceBendUpdate = 0;
    this.swimBend = Math.abs(this.targetBend) < this.model.length * 0.01 ? 0 : this.targetBend;
    this.swim.swimBend.value = this.swimBend;
  }

  updateJaw() {
    const jaw = this.model.jaw;
    if (!jaw || !this.jawPivot) return;
    const lateral = this.lateralOffset(jaw.midX);
    this.jawPivot.position.set(jaw.hinge.x, jaw.hinge.y, jaw.hinge.z + lateral);
    // The lower jaw drops, front first, about the hinge at the back of the mouth.
    this.jawPivot.rotation.set(0, 0, -0.75 * this.mouthOpen);
    this.upperTeeth.position.set(0, 0, lateral);
    this.palate.position.set(0, 0, lateral);
    // The inside of the mouth only exists while it's open.
    const shut = this.mouthOpen < 0.03;
    this.upperTeeth.visible = !shut;
    this.lowerTeeth.visible = !shut;
    this.palate.visible = !shut;
  }
}

// ---------------------------------------------------------------------------------------------
// EyeRig (FishEyes.swift): each eye swivels on its own toward whatever catches its attention,
// otherwise rests with a slow drift and the odd glance. Moves are saccades.
// ---------------------------------------------------------------------------------------------

class EyeRig {
  constructor(model, parent) {
    this.model = model;
    this.node = new THREE.Group();
    this.interest = rnd(0, 1);
    this.clock = rnd(0, 100);
    const material = model.material.clone();
    this.eyes = model.sockets.map((socket) => {
      const mesh = new THREE.Mesh(model.geometry, material);
      mesh.position.copy(socket.center);
      mesh.scale.setScalar(model.radius);
      mesh.quaternion.copy(socket.base);
      this.node.add(mesh);
      return {
        mesh, socket, gaze: new THREE.Vector2(), aim: new THREE.Vector2(), glance: new THREE.Vector2(),
        glanceTimer: rnd(0.5, 3), drift: new THREE.Vector2(rnd(0, TAU), rnd(0, TAU)),
      };
    });
    parent.add(this.node);
  }

  /** `lateral` is the head's sideways swim offset at the eyes, so they stay on the body as it bends. */
  update(dt, fish, tank, lateral) {
    this.node.position.set(0, 0, lateral);
    this.clock += dt;
    let target = this.lookTarget(fish, tank);
    if (target) {
      this.node.updateWorldMatrix(true, false);
      target = this.node.worldToLocal(target.clone());
    }
    const limit = new THREE.Vector2(this.model.reach, this.model.reach * 0.5);
    for (const eye of this.eyes) {
      const s = eye.socket;
      let want = null;
      if (target) {
        const d = unit(target.clone().sub(s.center));
        const dn = d.dot(s.neutral);
        // Only if it's on this eye's side; a clamped direction keeps the eye turned as far as it goes.
        if (dn > -0.1) {
          const a = new THREE.Vector2(Math.atan2(d.dot(s.fore), dn), Math.atan2(d.dot(s.up), dn));
          const e = new THREE.Vector2(a.x / limit.x, a.y / limit.y);
          want = e.length() > 1 ? a.divideScalar(e.length()) : a;
        }
      }
      if (!want) {
        eye.glanceTimer -= dt;
        if (eye.glanceTimer <= 0) {
          // Mostly glance fore/aft, and come back to rest between glances.
          const resting = eye.glance.x === 0 && eye.glance.y === 0;
          eye.glance = resting && Math.random() < 0.7
            ? new THREE.Vector2(rnd(-0.6, 0.6) * limit.x, rnd(-0.3, 0.3) * limit.y) : new THREE.Vector2();
          eye.glanceTimer = eye.glance.x === 0 && eye.glance.y === 0 ? rnd(1, 4) : rnd(0.4, 1.5);
        }
        const drift = new THREE.Vector2(Math.sin(this.clock * 0.31 + eye.drift.x) * limit.x,
          Math.sin(this.clock * 0.19 + eye.drift.y) * limit.y).multiplyScalar(0.15);
        want = eye.glance.clone().add(drift);
      }
      // Saccade to big changes; follow small ones slowly.
      const err = want.clone().sub(eye.aim);
      if (err.length() > 0.09) eye.aim.copy(want);
      else eye.aim.add(err.multiplyScalar(Math.min(1, dt * 2.5)));
      eye.gaze.add(eye.aim.clone().sub(eye.gaze).multiplyScalar(Math.min(1, dt * 25)));
      const dir = s.neutral.clone().add(s.fore.clone().multiplyScalar(Math.tan(eye.gaze.x)))
        .add(s.up.clone().multiplyScalar(Math.tan(eye.gaze.y))).normalize();
      eye.mesh.quaternion.copy(quatFromTo(s.neutral, dir).multiply(s.base));
    }
  }

  /** The world point this fish is most interested in, if any. */
  lookTarget(fish, tank) {
    const shark = tank.shark;
    if (shark) {
      if (shark.body === fish) return shark.state.kind === 'hunting' ? shark.state.target.pos : null;
      if (shark.state.kind === 'hunting' && fish.pos.distanceTo(shark.pos) < shark.body.model.length * 1.6) {
        return shark.pos.clone().add(shark.body.nose).multiplyScalar(0.5);
      }
    }
    const food = tank.nearestFood(fish.pos, 4);
    if (food) return food.pos;
    const c = tank.cursor;
    if (c.present) {
      const reach = c.stillTime > 0.5 ? 220 + 260 * this.interest : 150;
      if (tank.screenDistance(fish.pos, c.screen) < reach) {
        // Where the cursor appears: its line of sight, a little in front of the fish.
        const onRay = tank.closestPointOnCursorRay(fish.pos);
        return onRay.clone().add(unit(v3(0, 0, tank.eyeDistance).sub(onRay)).multiplyScalar(1.5));
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Fish behaviour (Fish.swift): wandering, schooling, food, curiosity, fear, glide-and-burst,
// C-start escapes
// ---------------------------------------------------------------------------------------------

/** How a species swims when unhurried: bursts of tail beats separated by glides (seconds). */
function strokeFor(sp) {
  switch (sp.id) {
    case Species.neonTetra.id: return { beat: [0.25, 0.45], glide: [0.3, 0.7], boost: 1.3, pickup: 3, drag: 1.5 };
    case Species.angelfish.id: return { beat: [0.5, 0.9], glide: [1.4, 2.8], boost: 1.35, pickup: 1.6, drag: 0.45 };
    case Species.clownfish.id: return { beat: [0.3, 0.6], glide: [0.2, 0.45], boost: 1.1, pickup: 2, drag: 1.3 };
    case Species.betta.id: return { beat: [0.7, 1.2], glide: [0.9, 1.7], boost: 1.1, pickup: 1.5, drag: 0.6 };
    default: return { beat: [0.7, 1.3], glide: [0.8, 1.5], boost: 1.2, pickup: 1.5, drag: 0.65 };
  }
}

class Fish {
  constructor(species, p) {
    this.species = species;
    this.stroke = strokeFor(species);
    this.model = FishModel.forSpecies(species);
    this.size = rnd(0.85, 1.15);
    this.rig = new FishRig(this.model, this.size);
    this.pos = p.clone();
    const angle = rnd(0, TAU);
    this.vel = v3(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(species.cruise * Fish.speedUnit * 0.5);
    this.goal = v3();
    this.goalTimer = 0;
    this.fear = 0;
    this.fleeDir = v3();
    this.yaw = Math.atan2(-this.vel.z, this.vel.x);
    this.roll = 0;
    this.orientation = quatAxis(this.yaw, 0, 1, 0);
    // Personality: curious fish come over to inspect a resting cursor.
    this.curiosity = rnd(0, 1);
    this.speedJitter = rnd(0.8, 1.2);
    this.hoverOffset = v3(rnd(0.45, 1.0) * (coin() ? 1 : -1), rnd(-0.4, 0.4), rnd(0.8, 3.5));
    this.schoolOffset = v3(rnd(-0.9, 0.9), rnd(-0.5, 0.5), rnd(-0.9, 0.9));
    this.beating = coin();
    this.strokeTimer = rnd(0, 0.5);
    this.thrust = 1;
    this.escapeTimer = 0;
    this.escapeKick = false;
    this.escapeCooldown = 0;
    this.lastForward = this.forward;
    this.node.position.copy(this.pos);
    this.node.quaternion.copy(this.orientation);
  }

  get node() { return this.rig.node; }
  get mouthOpen() { return this.rig.mouthOpen; }
  set mouthOpen(v) { this.rig.mouthOpen = v; }
  get forward() { return v3(1, 0, 0).applyQuaternion(this.orientation); }
  get nose() { return this.pos.clone().add(this.forward.multiplyScalar(this.model.length * 0.5 * this.size)); }

  update(dt, tank) {
    const sp = this.species;
    const cruise = sp.cruise * Fish.speedUnit * this.speedJitter;
    const burst = sp.burst * Fish.speedUnit;
    const c = tank.cursor;
    const desired = v3();
    let lookAt = null;
    const depthFrac = clamp(-this.pos.z / tank.depth, 0, 1);
    const fearBefore = this.fear;

    // --- Startle: react to where the fish *appears* relative to a fast-moving cursor.
    if (c.present) {
      const s2 = tank.project(this.pos);
      const dScreen = Math.hypot(s2.x - c.screen.x, s2.y - c.screen.y);
      const speed = c.speed;
      const moving = speed > 140;
      const radius = (110 + Math.min(speed, 2500) * 0.1) * (1 - 0.45 * depthFrac);
      if (dScreen < radius && (moving || dScreen < 45)) {
        const intensity = moving ? Math.min(1.4, 0.45 + speed / 900) : 0.5;
        const startle = Math.min(1, (1 - dScreen / radius) * intensity);
        if (startle > this.fear) {
          this.fear = startle;
          this.goalTimer = 0;
        }
        // Away from the cursor's line of sight, and back from the glass where the "hand" is.
        const away = unit(this.pos.clone().sub(tank.closestPointOnCursorRay(this.pos))).add(v3(0, 0, -0.7));
        if (moving) {
          // Dart sideways out of the cursor's path.
          const mv = unit(v3(c.vel.dx, c.vel.dy, 0));
          const side = v3(-mv.y, mv.x, 0);
          away.add(side.multiplyScalar(away.dot(side) >= 0 ? 0.8 : -0.8));
        }
        this.fleeDir = unit(away);
      }
    }
    // --- A hunting shark nearby: scatter.
    const threat = tank.shark ? tank.shark.threat(this) : null;
    if (threat) {
      if (threat.intensity > this.fear) {
        this.fear = threat.intensity;
        this.goalTimer = 0;
      }
      this.fleeDir = threat.away;
    }
    this.fear = Math.max(0, this.fear - dt * 0.55);
    const panic = this.escape(dt, fearBefore, burst);

    // --- Pick what we're swimming toward.
    let target;
    let targetSpeed = cruise;
    let feeding = false;
    const food = this.fear < 0.35 ? tank.nearestFood(this.pos, 7.5) : null;
    if (food) {
      target = food.pos.clone();
      targetSpeed = cruise * 2.2;
      feeding = true;
      if (this.nose.distanceTo(food.pos) < Math.max(0.1, this.model.length * 0.25 * this.size)) {
        tank.eat(food);
        this.rig.gulp();
      }
    } else if (c.present && c.stillTime > 0.7 && this.fear < 0.05 && this.curiosity > 0.45
      && tank.screenDistance(this.pos, c.screen) < 420) {
      // Swim up close, beside the cursor's line of sight, and turn to face the viewer.
      const g = tank.cursorGlassPoint;
      const z = Math.min(this.hoverOffset.z, tank.frontZ - 0.8);
      const f = (tank.eyeDistance - z) / tank.eyeDistance;
      target = v3((g.x + this.hoverOffset.x) * f, (g.y + this.hoverOffset.y) * f, z);
      targetSpeed = cruise * 1.2;
      lookAt = v3(g.x * f, g.y * f, z + 3);
    } else if (sp.schooling && tank.schoolGoal(sp)) {
      target = tank.schoolGoal(sp).clone().add(this.schoolOffset);
    } else {
      this.goalTimer -= dt;
      if (this.goalTimer <= 0 || this.pos.distanceTo(this.goal) < 0.3) this.pickGoal(tank);
      target = this.goal.clone();
    }
    const toTarget = target.clone().sub(this.pos);
    // Close to where it wants to be: hold station on the pectorals instead of beating the tail.
    const hovering = toTarget.length() < 0.6 && this.vel.length() < cruise * 0.6 && this.fear < 0.1;
    const propelling = this.updateStroke(dt, feeding || this.fear > 0.2, hovering);
    const surging = propelling && !hovering;
    const pace = surging ? this.stroke.boost : 1;
    desired.add(unit(toTarget).multiplyScalar(targetSpeed * pace * Math.min(1, toTarget.length() / 1.0) * (1 - this.fear)));

    // --- Neighbours: personal space, and schooling with our own kind.
    const align = v3(), centre = v3();
    let n = 0;
    const myRadius = this.model.length * this.size;
    for (const o of tank.fish) {
      if (o === this) continue;
      const dv = this.pos.clone().sub(o.pos);
      const d = dv.length();
      const minD = (myRadius + o.model.length * o.size) * 0.55 + 0.05;
      if (d < minD && d > 0.0001) desired.add(unit(dv).multiplyScalar((1 - d / minD) * cruise * 1.6));
      if (sp.schooling && o.species.id === sp.id && d < 1.6) {
        align.add(o.vel);
        centre.add(o.pos);
        n += 1;
      }
    }
    if (n > 0) {
      desired.add(align.divideScalar(n).sub(this.vel).multiplyScalar(0.35));
      desired.add(unit(centre.divideScalar(n).sub(this.pos)).multiplyScalar(cruise * 0.25));
    }

    // --- Steer around big scenery (reef mounds, corals).
    for (const o of tank.obstacles) {
      const dv = this.pos.clone().sub(o.center);
      const d = dv.length();
      const r = o.radius + myRadius * 0.5 + 0.2;
      if (d < r && d > 0.0001) desired.add(unit(dv).multiplyScalar((1 - d / r) * cruise * 3));
    }

    // --- Stay inside the tank (soft walls).
    const b = tank.bounds(this.pos, myRadius);
    const push = cruise * 2.5;
    const m = 0.9;
    const p = this.pos;
    if (p.x < b.minX + m) desired.x += (b.minX + m - p.x) / m * push;
    if (p.x > b.maxX - m) desired.x -= (p.x - (b.maxX - m)) / m * push;
    if (p.y < b.minY + m * 0.6) desired.y += (b.minY + m * 0.6 - p.y) / (m * 0.6) * push;
    if (p.y > b.maxY - m * 0.6) desired.y -= (p.y - (b.maxY - m * 0.6)) / (m * 0.6) * push;
    if (p.z < b.minZ + m) desired.z += (b.minZ + m - p.z) / m * push;
    if (p.z > b.maxZ - m * 0.5) desired.z -= (p.z - (b.maxZ - m * 0.5)) / (m * 0.5) * push;

    // --- Flee.
    desired.add(this.fleeDir.clone().multiplyScalar(burst * this.fear));

    // --- Coasting: without the tail nothing adds speed; water drag slowly bleeds it off.
    if (!propelling && panic < 0.01) {
      this.vel.multiplyScalar(Math.max(0, 1 - this.stroke.drag * dt));
      const coast = this.vel.length();
      const want = desired.length();
      if (want > coast) desired.multiplyScalar(coast / want);
    }

    // Tail beats also make for quicker turns and pickup than a glide.
    const agility = (1.6 + 7 * panic) * (surging ? this.stroke.pickup : 1);
    this.rig.thrust = this.thrust;
    this.move(desired, dt, cruise, (cruise * 1.4 + (burst - cruise * 1.4) * panic) * pace, agility,
      cruise * 0.8 + burst * panic * 0.5, panic, lookAt, b, tank);
  }

  /** Advance the burst-and-glide cycle and ease `thrust` toward it. Returns whether the fish is
   *  under power (false = coasting). */
  updateStroke(dt, sustained, hovering) {
    this.strokeTimer -= dt;
    // A glide ends early once the fish has slowed right down.
    const slow = this.vel.length() < this.species.cruise * Fish.speedUnit * 0.45;
    if (this.strokeTimer <= 0 || (!this.beating && slow && !hovering)) {
      this.beating = !this.beating;
      this.strokeTimer = this.beating ? rnd(...this.stroke.beat) : rnd(...this.stroke.glide);
    }
    const powered = sustained || this.escapeTimer > 0 || this.beating;
    const goal = hovering
      ? clamp(0.1 + 0.6 * this.vel.length() / (this.species.cruise * Fish.speedUnit), 0.1, 0.45)
      : (powered ? 1 : 0);
    // The tail picks up quickly and settles a little more gently.
    this.thrust += (goal - this.thrust) * Math.min(1, dt * (goal > this.thrust ? 10 : 7));
    return powered || hovering;
  }

  /** C-start: on the onset of a fright, curl hard into a C away from the threat, pivot toward the
   *  escape, then push off at burst speed. Returns the effective panic level. */
  escape(dt, fearBefore, burst) {
    this.escapeCooldown -= dt;
    if (this.fear > 0.4 && fearBefore <= 0.4 && this.escapeCooldown <= 0) {
      this.escapeTimer = 0.4;
      this.escapeKick = true;
      this.escapeCooldown = rnd(1.4, 2.2);
      // Which side of the fish the escape lies on (its local +z / -z).
      const side = this.fleeDir.dot(v3(0, 0, 1).applyQuaternion(this.orientation));
      const sign = Math.abs(side) > 0.1 ? (side > 0 ? 1 : -1) : (coin() ? 1 : -1);
      this.rig.curl(sign * (0.35 + 0.2 * Math.min(1, this.fear)));
      // Stage one: pivot toward the escape without much forward travel.
      this.vel = this.fleeDir.clone().multiplyScalar(this.vel.length() * 0.4);
    }
    if (!(this.escapeTimer > 0)) return this.fear;
    this.escapeTimer -= dt;
    if (this.escapeKick && this.escapeTimer < 0.32) {
      // Stage two: the tail snaps back and the fish shoots off.
      this.escapeKick = false;
      this.vel = this.fleeDir.clone().multiplyScalar(Math.max(this.vel.length(), burst * (0.6 + 0.2 * this.fear)));
    }
    return Math.max(this.fear, Math.min(1, this.escapeTimer / 0.25));
  }

  /** Steer toward the desired velocity, stay inside b, turn to face the heading (or `lookAt` when
   *  nearly still), bank into turns and animate the tail. Shared by fish and the shark. */
  move(desired, dt, cruise, maxSpeed, agility, maxClimb, excitement, lookAt, b, tank) {
    this.vel.add(desired.clone().sub(this.vel).multiplyScalar(Math.min(1, dt * agility)));
    this.vel.clampLength(0, maxSpeed);
    // Fish rarely swim straight up or down.
    this.vel.y = clamp(this.vel.y, -maxClimb, maxClimb);
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x = clamp(this.pos.x, b.minX - 0.2, b.maxX + 0.2);
    this.pos.y = clamp(this.pos.y, b.minY - 0.1, b.maxY + 0.1);
    this.pos.z = clamp(this.pos.z, b.minZ - 0.2, b.maxZ + 0.1);

    // --- Orientation: head along velocity (or toward what we're looking at), bank into turns.
    const speed = this.vel.length();
    let heading = this.vel.clone();
    if (lookAt && speed < cruise * 0.6) heading = lookAt.clone().sub(this.pos);
    const flat = Math.hypot(heading.x, heading.z);
    if (flat > 0.02 || Math.abs(heading.y) > 0.02) {
      const newYaw = flat > 0.01 ? Math.atan2(-heading.z, heading.x) : this.yaw;
      const pitch = clamp(Math.atan2(heading.y, Math.max(flat, 0.001)), -0.6, 0.6);
      const yawRate = angleDelta(newYaw, this.yaw) / Math.max(dt, 0.001);
      this.yaw = newYaw;
      this.roll += (clamp(-yawRate * 0.12, -0.5, 0.5) - this.roll) * Math.min(1, dt * 3);
      const q = quatAxis(this.yaw, 0, 1, 0).multiply(quatAxis(pitch, 0, 0, 1)).multiply(quatAxis(this.roll, 1, 0, 0));
      this.orientation.slerp(q, Math.min(1, dt * (3 + 8 * excitement)));
    }

    // How fast the body is actually rotating, for the turn bend.
    const fwd = this.forward;
    const turnRate = dt > 0
      ? angleDelta(Math.atan2(-fwd.z, fwd.x), Math.atan2(-this.lastForward.z, this.lastForward.x)) / dt : 0;
    this.lastForward = fwd;

    this.node.position.copy(this.pos);
    this.node.quaternion.copy(this.orientation);
    this.rig.animate(dt, this, speed, cruise, excitement, turnRate, tank);
  }

  pickGoal(tank) {
    // Clownfish mostly stay close to their anemone.
    if (this.species.id === Species.clownfish.id && tank.anemoneTop && Math.random() < 0.75) {
      this.goal = tank.anemoneTop.clone().add(v3(rnd(-0.5, 0.5), rnd(0.05, 0.6), rnd(-0.45, 0.45)));
      this.goalTimer = rnd(2, 5);
      return;
    }
    this.goal = tank.wanderPoint(this.species.band, this.pos);
    this.goalTimer = rnd(4, 11);
  }

  /** Fish get no caustics or fin glow at night. */
  setCausticScale(scale) { this.rig.setCausticScale(scale); }
}
/** Screen-points-per-second in the species data → world units per second. */
Fish.speedUnit = 1.2 / 100;

// ---------------------------------------------------------------------------------------------
// The shark (Shark.swift): lurks in the haze, now and then hunts a fish, then retreats
// ---------------------------------------------------------------------------------------------

class Shark {
  constructor(tank) {
    this.body = new Fish(Species.shark, v3());
    this.body.node.scale.setScalar(1);
    this.clock = 0;
    this.biteTimer = 0;
    this.gliding = false;
    this.glideTimer = 2;
    this.state = { kind: 'lurking', until: Shark.huntSoon ? 2 : rnd(15, 40) };
    this.patrol = this.lurkPoint(tank);
    this.body.pos = this.lurkPoint(tank);
    this.body.node.position.copy(this.body.pos);
  }

  get pos() { return this.body.pos; }

  update(dt, tank) {
    this.clock += dt;
    const sp = this.body.species;
    const cruise = sp.cruise * Fish.speedUnit;
    let desired = v3();
    let speed = cruise;
    let excitement = 0;
    // How wide the mouth should be, and how fast it gets there.
    let gape = 0;
    let jawRate = 3;
    const pos = this.pos;

    switch (this.state.kind) {
      case 'lurking': {
        // Slow patrols around the hazy region behind the tank, gliding between a few tail beats.
        this.glideTimer -= dt;
        if (this.glideTimer <= 0) {
          this.gliding = !this.gliding;
          this.glideTimer = this.gliding ? rnd(2.5, 5) : rnd(1.5, 3);
        }
        speed = cruise * (this.gliding ? 1.2 : 1.8);
        if (pos.distanceTo(this.patrol) < 1.5) this.patrol = this.lurkPoint(tank);
        desired = unit(this.patrol.clone().sub(pos)).multiplyScalar(speed);
        if (this.clock > this.state.until) {
          const prey = this.pickPrey(tank);
          if (prey) this.state = { kind: 'hunting', target: prey, since: this.clock };
        }
        break;
      }
      case 'hunting': {
        const prey = this.state.target;
        if (!tank.fish.includes(prey) || this.clock - this.state.since >= 10) {
          this.state = { kind: 'retreating' };
          break;
        }
        // Aim a little ahead of the prey; charge in from the dark, then lunge from close range.
        const lead = prey.pos.clone().addScaledVector(prey.vel, 0.35);
        const d = this.body.nose.distanceTo(prey.pos);
        const close = this.body.model.length * 0.7;
        speed = d > close ? 5.5 : 9;
        excitement = d > close ? 0.7 : 1;
        desired = unit(lead.sub(pos)).multiplyScalar(speed);
        // Jaws part as it closes in, and gape wide for the final lunge.
        gape = d > close * 1.6 ? 0.15 : 1;
        jawRate = 6;
        if (d < 0.3 + prey.model.length * prey.size * 0.5) {
          tank.eaten(prey);
          this.state = { kind: 'retreating' };
          this.patrol = this.lurkPoint(tank);
          this.biteTimer = 0.5;
        }
        break;
      }
      case 'retreating':
        // Back into the dark quickly, easing off as it disappears into the murk.
        speed = pos.z > -tank.depth - 6 ? 4.5 : 2;
        excitement = 0.5;
        desired = unit(this.patrol.clone().sub(pos)).multiplyScalar(speed);
        if (pos.z < -tank.depth - 10 || pos.distanceTo(this.patrol) < 2) {
          this.state = { kind: 'lurking', until: this.clock + rnd(30, 110) };
        }
        break;
    }

    if (this.biteTimer > 0) {
      this.biteTimer -= dt;
      gape = 0;
      jawRate = 18;
    }
    this.body.mouthOpen += (gape - this.body.mouthOpen) * Math.min(1, dt * jawRate);
    this.body.rig.thrust = this.state.kind === 'lurking' && this.gliding ? 0.1 : 1;

    // Steer around the reef.
    for (const o of tank.obstacles) {
      const dv = pos.clone().sub(o.center);
      const d = dv.length();
      const r = o.radius + this.body.model.length * 0.4 + 0.3;
      if (d < r && d > 0.0001) desired.add(unit(dv).multiplyScalar((1 - d / r) * speed * 2));
    }

    // Soft walls: turn back well before reaching the edge of its space.
    const b = this.roamBounds(tank, pos.x, pos.z);
    const m = 1.5, push = Math.max(speed, cruise * 2) * 1.5;
    if (pos.x < b.minX + m) desired.x += (b.minX + m - pos.x) / m * push;
    if (pos.x > b.maxX - m) desired.x -= (pos.x - (b.maxX - m)) / m * push;
    if (pos.y < b.minY + m * 0.5) desired.y += (b.minY + m * 0.5 - pos.y) / (m * 0.5) * push;
    if (pos.y > b.maxY - m * 0.5) desired.y -= (pos.y - (b.maxY - m * 0.5)) / (m * 0.5) * push;
    if (pos.z < b.minZ + m) desired.z += (b.minZ + m - pos.z) / m * push;
    if (pos.z > b.maxZ - m) desired.z -= (pos.z - (b.maxZ - m)) / m * push;
    this.body.move(desired, dt, cruise, speed, 1.2 + 3.5 * excitement, speed * 0.5, excitement, null, b, tank);
  }

  /** How a fish should react to the shark: flee direction and fear, or null. */
  threat(fish) {
    const hunting = this.state.kind === 'hunting';
    const isPrey = hunting && this.state.target === fish;
    // Scaled to the shark's size (these suit a ~3-unit-long shark).
    const reach = this.body.model.length / 3;
    const radius = (isPrey ? 4 : (hunting ? 3 : 1.6)) * reach;
    const dv = fish.pos.clone().sub(this.pos);
    const d = dv.length();
    if (!(d < radius)) return null;
    // Away from the shark and out of its path.
    const side = unit(this.body.vel).cross(v3(0, 1, 0));
    const away = unit(unit(dv).add(side.multiplyScalar(dv.dot(side) >= 0 ? 0.7 : -0.7)));
    return { away, intensity: Math.min(1, (1 - d / radius) * (hunting ? 1.3 : 0.5)) };
  }

  /** The space the shark may occupy at depth z, allowing for its size. */
  roamBounds(tank, x, z) {
    const len = this.body.model.length;
    const hw = tank.halfWidth(z) - len * 0.35;
    const hh = tank.halfHeight(z);
    return {
      minX: -hw, maxX: hw,
      minY: tank.floorHeight(x, z) + len * 0.15 + 0.4,
      maxY: Math.min(tank.surfaceY, hh * 0.91) - len * 0.12 - 0.3,
      minZ: -tank.depth - 13.5, maxZ: tank.frontZ - 2,
    };
  }

  /** Deep in the haze behind where the fish swim, just short of where the fog turns opaque. */
  lurkPoint(tank) {
    const z = -tank.depth - rnd(11.5, 13);
    const b0 = this.roamBounds(tank, 0, z);
    const x = rnd(b0.minX + 1.5, b0.maxX - 1.5);
    const b = this.roamBounds(tank, x, z);
    const lo = b.minY + 0.8, hi = Math.max(lo, b.maxY - 0.8);
    return v3(x, lo + (hi - lo) * rnd(0.2, 0.8), z);
  }

  /** A fish to go after: not too close to the viewer, never a clownfish sheltering in its anemone. */
  pickPrey(tank) {
    const candidates = tank.fish.filter((f) => {
      if (f.pos.z > 1.5) return false;
      if (f.species.id === Species.clownfish.id && tank.anemoneTop && f.pos.distanceTo(tank.anemoneTop) < 1) return false;
      return true;
    });
    return candidates.length ? pick(candidates) : null;
  }
}
Shark.huntSoon = false;

// ---------------------------------------------------------------------------------------------
// Sinking food flakes (Food.swift)
// ---------------------------------------------------------------------------------------------

class Food {
  constructor(p) {
    if (!Food.geometry) {
      Food.geometry = new THREE.SphereGeometry(0.028, 8, 6);
      Tank.sharedGeometry.add(Food.geometry);
    }
    Food.material ??= new THREE.MeshStandardMaterial({ color: new RGBA(0.72, 0.42, 0.18).color, roughness: 0.7, transparent: true });
    this.node = new THREE.Mesh(Food.geometry, Food.material.clone());
    this.node.castShadow = true;
    this.pos = p.clone();
    this.vy = rnd(-0.15, -0.05);
    this.age = 0;
    this.wobble = rnd(0, TAU);
    this.eaten = false;
    this.node.position.copy(p);
    this.node.scale.set(rnd(0.8, 1.2), rnd(0.5, 0.8), rnd(0.8, 1.2));
  }

  /** Returns false once the flake has dissolved or been eaten. */
  update(dt, floor) {
    this.age += dt;
    if (this.pos.y > floor) {
      this.vy = Math.max(this.vy - 0.18 * dt, -0.26);
      this.pos.y = Math.max(floor, this.pos.y + this.vy * dt);
      this.pos.x += Math.sin(this.age * 2 + this.wobble) * 0.08 * dt;
      this.node.rotation.x += dt * 0.6;
      this.node.rotation.y += dt * 0.4;
    }
    this.node.position.copy(this.pos);
    const life = 40;
    this.node.material.opacity = clamp((life - this.age) / 4, 0, 1);
    return this.age < life && !this.eaten;
  }
}
