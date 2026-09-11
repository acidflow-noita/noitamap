# Search inventory regression

`306813029-great-chests.json` contains the eight natural great-chest records and
Leviathan's raw reward-bearing record from the app's real approximate generation
of seed **306813029**, normal NG0 with all unlocks and three horizontal worlds.
Natural chest loot is omitted: these tests need their real identities/positions,
not their unrelated contents. Leviathan's two rewards are retained unchanged.

The expected natural count **8** is the Sage reference supplied with the bug
report. No Sage source or service is used by these tests.

Before the fix, the app's actual search returned ten rows: the eight chests,
Leviathan (matched by reward text), and a separate great-chest reward entry at
(-13967, 10029). The fixture exercises that shape through the shared inventory
projection and the real search index, without subtracting a hardcoded number
or deduplicating by coordinates.
