"""Execute Noita's inspected movement routine against synthetic material fields.
Requires Unicorn and the particle project's tools/noita_reference.py. No browser,
running game, game-code export, or writes to the executable. --matrix also applies
the ordinary float32 position/lifetime update before each native movement call.
"""
import argparse
import json
import struct
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', required=True)
    parser.add_argument('--reference-tools', required=True)
    parser.add_argument('--matrix', action='store_true')
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.reference_tools).resolve()))
    from noita_reference import Reference
    from unicorn import UC_HOOK_CODE
    from unicorn.x86_const import UC_X86_REG_ESP, UC_X86_REG_EIP, UC_X86_REG_EAX

    r = Reference(args.executable)
    u = r.uc
    world, particle, candidate, obj, vtable, manager, materials, cell, cellref, grid = [
        r.data + i for i in (0, 0x100, 0x200, 0x1000, 0x2000, 0x3000, 0x4000, 0x6000, 0x7000, 0x8000)]
    getworld = r.data + 0x9000
    getmat = getworld + 16

    def put(address, *values):
        u.mem_write(address, struct.pack('<' + 'I' * len(values), *values))

    put(world + 0x10, (-1000000) & 0xffffffff, (-1000000) & 0xffffffff, 1000000, 1000000)
    put(world + 0x20, obj, grid, manager)
    put(obj, vtable)
    put(vtable + 12, getworld)
    put(vtable + 8, getmat)
    put(manager + 0x18, materials)
    put(cell, vtable)
    put(grid, 10000, 10000)
    queries = []
    field = {}

    def ret(value=0, pop=0):
        sp = u.reg_read(UC_X86_REG_ESP)
        target = struct.unpack('<I', u.mem_read(sp, 4))[0]
        u.reg_write(UC_X86_REG_EAX, value)
        u.reg_write(UC_X86_REG_ESP, sp + 4 + pop)
        u.reg_write(UC_X86_REG_EIP, target)

    def hook(uc, address, size, _):
        if address == getworld:
            ret(obj)
        elif address == getmat:
            ret(1)
        elif address == 0x89c2d0:
            sp = u.reg_read(UC_X86_REG_ESP)
            x, y = struct.unpack('<ii', u.mem_read(sp + 4, 8))
            queries.append([x, y])
            value = x if field['axis'] == 'x' else y
            occupied = value >= field['boundary'] if field['positive'] else value <= field['boundary']
            put(cellref, cell if occupied and field['kind'] else 0)
            ret(cellref, 8)

    u.hook_add(UC_HOOK_CODE, hook)
    f32 = lambda value: struct.unpack('<f', struct.pack('<f', value))[0]
    dt = f32(1 / 60)
    defaults = dict(x=.5, y=-.5, vx=0, vy=60, life=20, collide=True, bounce=True,
                    rng=12345, frames=1, kind=3, axis='y', boundary=0, positive=True, particleKind=4)
    cases = [('air', dict(collide=False, bounce=False)), ('kill', dict(bounce=False)), ('bounce', {})]
    if args.matrix:
        cases += [
            ('liquid', dict(kind=1)), ('gas', dict(kind=2)), ('fire', dict(kind=4)), ('empty', dict(kind=0)),
            ('liquid-particle-cannot-bounce', dict(particleKind=1)),
            ('horizontal-wall', dict(x=-.5, y=.5, vx=60, vy=0, axis='x')),
            ('diagonal-vertical', dict(x=-.5, y=-.5, vx=60, vy=120)),
            ('diagonal-horizontal', dict(x=-.5, y=-.5, vx=120, vy=60, axis='x')),
            ('negative-wall', dict(x=-3.5, y=-3.5, vx=-60, vy=0, axis='x', boundary=-4, positive=False)),
            ('negative-ceiling', dict(x=-3.5, y=-3.5, vy=-60, boundary=-4, positive=False)),
            ('short-life', dict(life=.8)), ('near-one-life-can-increase', dict(life=1.1)), ('fast-no-life-reduction', dict(vy=600)),
            ('slow-bounce-clears-flag', dict(vy=24, y=-.25, frames=8)),
            ('repeated-bounce-then-kill', dict(y=-1.5, frames=120)),
            ('long-sampled-motion', dict(y=-6.5, vy=600)),
            ('sixty-sample-cap', dict(y=-70.5, vy=6000)),
            ('subpixel-motion', dict(y=-1.1, vy=3, frames=24)),
            ('sample-contact-not-endpoint', dict(y=-3.5, collisionY=-2, vy=150)),
            ('high-rng-state', dict(rng=2147483646)),
            ('west-world', dict(x=-35000.5, y=2047.5, boundary=2048, frames=120)),
            ('east-world', dict(x=35000.5, y=2047.5, boundary=2048, frames=120)),
        ]
    results = []
    for name, overrides in cases:
        c = {**defaults, **overrides}
        field.update({key: c[key] for key in ('axis', 'boundary', 'positive', 'kind')})
        put(materials + 0x290 + 0x38, c['kind'])
        u.mem_write(0x01222388, struct.pack('<d', c['rng']))
        raw = bytearray(0x70)
        for off, value in [(0x1c, c['x']), (0x20, c['y']), (0x54, c.get('collisionX', c['x'])),
                           (0x58, c.get('collisionY', c['y'])), (0x2c, c['vx']), (0x30, c['vy']), (0x5c, c['life'])]:
            struct.pack_into('<f', raw, off, value)
        raw[0x68] = c['particleKind']
        raw[0x6a] = 0x20 if c['bounce'] else 0
        raw[0x6b] = 2 if c['collide'] else 0
        u.mem_write(particle, bytes(raw))
        frames = []
        for _ in range(c['frames']):
            x, y = struct.unpack_from('<ff', raw, 0x1c)
            vx, vy = struct.unpack_from('<ff', raw, 0x2c)
            life = struct.unpack_from('<f', raw, 0x5c)[0]
            if args.matrix:
                u.mem_write(particle + 0x5c, struct.pack('<f', f32(life - dt)))
            u.mem_write(candidate, struct.pack('<ff', f32(x + f32(vx * dt)), f32(y + f32(vy * dt))))
            queries.clear()
            r.call(0x712390, (world, candidate), ecx=particle)
            raw = u.mem_read(particle, 0x70)
            output = {key: struct.unpack_from('<f', raw, offset)[0] for key, offset in (
                ('x', 0x1c), ('y', 0x20), ('vx', 0x2c), ('vy', 0x30), ('life', 0x5c))}
            output.update(dead=bool(raw[0x6a] & 0x10), queries=queries.copy())
            if args.matrix:
                output.update(collisionX=struct.unpack_from('<f', raw, 0x54)[0],
                              collisionY=struct.unpack_from('<f', raw, 0x58)[0],
                              rng=int(struct.unpack('<d', u.mem_read(0x01222388, 8))[0]),
                              bounce=bool(raw[0x6a] & 0x20))
            frames.append(output)
            if output['dead'] or output['life'] < 0:
                break
        results.append(dict(name=name, input=c, frames=frames) if args.matrix else
                       dict(collide=c['collide'], bounce=c['bounce'], **frames[0]))
    metadata = dict(executableSha256=r.sha256, function='0x00712390')
    if not args.matrix:
        metadata.update(syntheticFloorY=0, syntheticCellType=3, cosmeticRngState=12345)
    print(json.dumps({**metadata, 'results': results}, indent=2))


if __name__ == '__main__':
    main()
