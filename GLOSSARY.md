# Portfolio Island (Life Island)

A small walkable planet that works as Abbas's interactive portfolio. Visitors explore it, meet the villagers and can leave a lead or sign the guestbook. This glossary covers the world, its people and the ways visitors get in touch.

## The world

**World**:
The spherical island planet, with its terrain, sea and the second islet.
_Avoid_: map, level, scene (in prose)

**World law**:
One of the rules in CLAUDE.md that every new asset must obey, each learned by shipping the opposite.
_Avoid_: guideline, convention

**Plumb up**:
The radial direction from the world's centre through an object. Anything that stands (trees, buildings, people) points along it.
_Avoid_: up (unqualified), vertical

**Slope normal**:
The direction straight out of the ground at a point. Only soft ground clutter (grass, rocks, feed piles) may follow it.
_Avoid_: up, surface up

**Arc**:
A distance measured in metres along the world's surface.
_Avoid_: angle, radians (for a spacing)

**Angle**:
A position or spread on the world in longitude and latitude. It holds its meaning at any world radius, where an arc does not.
_Avoid_: arc (for this meaning)

**World radius**:
The size of the world. It converts angles to arcs.
_Avoid_: scale, size (as a term)

## People

**Villager**:
A resident character who lives on the world, has routines and can be chatted with.
_Avoid_: NPC, agent (in prose and copy; `NPC` stays in code identifiers)

**Visitor**:
A person playing the island in their browser.
_Avoid_: user, player (in docs)

**Peer**:
Another visitor seen live through multiplayer.
_Avoid_: remote player, other user

**Rest pose**:
How an avatar's limbs hang when nothing animates them. On the island's rigs the limbs hang near ±π, not at zero.
_Avoid_: T-pose, default pose, zero pose

**Canned line**:
A villager's written dialogue, used when the live chat model can't answer.
_Avoid_: fallback (in copy), scripted reply

## Getting in touch

**Lead**:
A visitor's request to hear from Abbas, sent with an email address from the contact form or the "say hi" modal. Abbas is emailed about each one.
_Avoid_: contact message, submission, enquiry (in code)

**Guestbook entry**:
A public note a visitor leaves without an email. Other visitors can read it, and nobody is emailed.
_Avoid_: lead, comment, message

## Relationships

- A **Villager** stands along the **Plumb up**, never the **Slope normal**.
- An **Arc** becomes an **Angle** through the **World radius**.
- A "say hi" with an email is a **Lead**; without one it is a **Guestbook entry**.
- A **Villager** answers with a **Canned line** whenever the live chat can't.

## Flagged ambiguities

- "NPC", "agent" and "villager" all name the same characters. They are **Villagers**. Only "agent" also means the ElevenLabs reception agent.
- An island **Lead** is not yet the same record as a website **Lead**: it lives in this project's database and never reaches the website's admin › Leads (see `docs/design/island-map.md`).
- "Freeze" meant the renderer's static-matrix freeze and shadow freeze. The 31 Mar 2027 **demo freeze** is a different thing, defined in `docs/design/island-map.md`.
