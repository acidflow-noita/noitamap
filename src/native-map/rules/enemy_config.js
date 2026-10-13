// Adapted into the owned Noitamap rules runtime. See NOTICE.txt for provenance.
/*
Time-based checks for enemy spawns:
- christmas: 12/24 - 12/26
- august24: 8/24
- jussi: 6/19 - 6/25
*/

const COALMINE_ENEMIES = {
	small: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/zombie_weak.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/slimeshooter_weak.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/longleg.xml"
		},
		{
			prob   		: 0.25,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_weak.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner_weak.xml"
		},
	],
	big: [
		{
			prob   		: 0.7,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/firemage_weak.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/worm.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 5,
			max_count	: 10,
			entity 	: "data/entities/animals/longleg.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/miner_weak.xml",
				"data/entities/animals/miner_weak.xml",
				"data/entities/animals/shotgunner_weak.xml",
			]
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_santa.xml",
			spawn_check : "christmas",
		},
		{
			prob   		: 0.20,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner_weak.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/acidshooter_weak.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/giantshooter_weak.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fireskull.xml"
		},	
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_santa.xml",
			spawn_check : "christmas",
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shaman.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml",
			ngpluslevel : 2,
		},
	],
	unique: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/slimeshooter_weak.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/acidshooter_weak.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/giantshooter_weak.xml"
		},
	],
	unique2: [
		{
			prob   		: 1.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/miner_santa.xml",
			spawn_check : "christmas",
		},
		{
			prob   		: 0.85,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner_weak.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 2,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_weak.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/slimeshooter_weak.xml"
		},
	],
	unique3: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.7,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/firemage_weak.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/alchemist.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage.xml"
		},
	],
	fungi: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fungus.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fungus_big.xml"
		},
	],
	nest: [
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: "data/entities/buildings/flynest.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: ""
		},
	],
};

const COALMINE_ALT_ENEMIES = {
	small: [
		{
			prob   		: 1.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/zombie.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/frog.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 2,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_weak.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_fire.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_dark.xml",
			ngpluslevel : 1,
		},
	],
	big: [
		{
			prob   		: 1.7,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/firemage_weak.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/worm.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/miner.xml",
				"data/entities/animals/miner.xml",
				"data/entities/animals/shotgunner.xml",
			]
		},
		{
			prob   		: 0.12,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/acidshooter.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/giantshooter.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fireskull.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 3,
			max_count	: 5,
			entity 	: "data/entities/animals/frog.xml"
		},
		{
			prob   		: 0.13,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/frog_big.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/frog.xml",
				"data/entities/animals/frog.xml",
				"data/entities/animals/frog_big.xml",
			]
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_santa.xml",
			spawn_check : "christmas",
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shaman.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_clusterbomb.xml",
			ngpluslevel : 1,
		},
	],
	unique: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/acidshooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/giantshooter.xml"
		},
	],
	unique2: [
		{
			prob   		: 1.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/miner_santa.xml",
			spawn_check : "christmas",
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 2,
			max_count	: 2,
			entity 	: "data/entities/animals/miner.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
	],
	unique3: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/firemage_weak.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage.xml"
		},
	],
	fungi: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fungus.xml"
		},
	],
	nest: [
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: "data/entities/buildings/flynest.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: ""
		},
	],
};

const EXCAVATIONSITE_ENEMIES = {
	small: [
		{
			prob   		: 0.55,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/firebug.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 4,
			entity 	: "data/entities/animals/rat.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 2,
			max_count	: 5,
			entity 	: "data/entities/animals/bat.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/bigfirebug.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 2,  
			entity 	: "data/entities/animals/goblin_bomb.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_hearty.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/slimespirit.xml",
		},
	],
	big: [
		{
			prob   		: 0.98,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				"data/entities/animals/miner.xml",
				"data/entities/animals/shotgunner.xml",
			]
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/miner_fire.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fireskull.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/bigbat.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_mine.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_santa.xml",
			spawn_check : "christmas",
		},
		{
			prob   		: 0.2,
			min_count	: 2,
			max_count	: 4,
			entity 	: "data/entities/animals/firebug.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/bigfirebug.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/alchemist.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml",
			ngpluslevel : 1,
		},
	],
	unique: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/acidshooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/giantshooter.xml"
		},
	],
	unique2: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/miner_santa.xml",
			spawn_check : "christmas",
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
	],
	unique3: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/firemage.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage.xml"
		},
	],
	nest: [
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: "data/entities/buildings/firebugnest.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: ""
		},
	],
};

const FUNGICAVE_ENEMIES = {
	small: [
		{
			prob   		: 0.2,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/zombie.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/rat.xml"
		},
			{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/fungus.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/acidshooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/ant.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 4,
			entity 	: "data/entities/animals/blob.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tentacler.xml"
		},
		{
			prob   		: 0.11,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tentacler_small.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/tentacler_small.xml",
				"data/entities/animals/tentacler.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wizard_tele.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_dark.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_swapper.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_invis.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/frog.xml",
				"data/entities/animals/frog.xml",
				"data/entities/animals/frog_big.xml",
			]
		},
	],
	big: [
		{
			prob   		: 0.7,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/thundermage.xml"
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/fungus.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/acidshooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/giantshooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 3,
			max_count	: 5,
			entity 	: "data/entities/animals/blob.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/bigzombie.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_poly.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/maggot.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/alchemist.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fungus_big.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.06,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_twitchy.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 3,
					entity	: "data/entities/animals/fungus.xml",
				},
				{
					min_count	: 1,
					max_count	: 1,
					entity	: "data/entities/animals/fungus_big.xml",
				},
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/slimespirit.xml",
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/confusespirit.xml",
		},
	],
	robots: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/roboguard.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/drone_physics.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/assassin.xml"
		},
	],
	nest: [
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: "data/entities/buildings/flynest.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: "data/entities/buildings/spidernest.xml"
		},
	],
};

const SNOWCAVE_ENEMIES = {
	small: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 4,
			entity 	: "data/entities/animals/rat.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/iceskull.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/scavenger_grenade.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/scavenger_smg.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/scavenger_smg.xml",
				"data/entities/animals/scavenger_grenade.xml"
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 1,
			entity 	: "data/entities/animals/thundermage.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 2,
			entity 	: "data/entities/animals/thundermage_big.xml"
		},
	],
	big: [
		{
			prob   		: 0.3,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.15,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 1,
			entity 	: "data/entities/animals/thundermage_big.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/worm_big.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/worm.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/worm_tiny.xml"
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/iceskull.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/giant.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/icemage.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 1,
					max_count 	: 1,
					entity : "data/entities/animals/sniper.xml",
				},
				{
					min_count	: 0,
					max_count 	: 2,
					entity : "data/entities/animals/shotgunner.xml",
				},
			]
		},
		{
			prob   		: 0.2,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/scavenger_grenade.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/scavenger_smg.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
			]
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel : 1,
			entities 	: [
				{
					min_count	: 1,
					max_count 	: 1,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 0,
					max_count 	: 1,
					entity : "data/entities/animals/coward.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				"data/entities/animals/scavenger_leader.xml",
			]
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 		: "data/entities/animals/monk.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 		: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thunderskull.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 4,
			entity 	: "data/entities/animals/scavenger_glue.xml",
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/hpcrystal.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/easter/sniper.xml",
			spawn_check : "august24",
		},
	],
	scavenger_party: [
		{
			prob   		: 1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 0,
					max_count 	: 1,
					entity : "data/entities/animals/coward.xml",
				},
				"data/entities/animals/scavenger_leader.xml",
			]
		},
	],
	unique: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.001,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_tele.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_dark.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_swapper.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necromancer.xml"
		},
	],
	unique2: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.6,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/scavenger_grenade.xml"
		},
		{
			prob   		: 0.6,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/scavenger_smg.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper.xml"
		}
	],
	fish: [
		{
			prob   		: 1.0,
			min_count	: 3,
			max_count	: 4,
			entity 	: "data/entities/animals/fish_large.xml"
		},
		{
			prob   		: 5.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: ""
		},
	]
};


const WANDCAVE_ENEMIES = {
	small: [
		{
			prob   		: 0.3,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wand_ghost.xml"
		},
	],
	big: [
		{
			prob   		: 0.3,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/statue_physics.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/phantom_a.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/phantom_b.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necromancer.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_returner.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_hearty.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith_glowing.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/enlightened_alchemist.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/failed_alchemist.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/weakspirit.xml",
			ngpluslevel : 1,
		},
	]
};

const SNOWCASTLE_ENEMIES = {
	small: [
		{
			prob   		: 0.2,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				"data/entities/animals/scavenger_grenade.xml",
				"data/entities/animals/scavenger_smg.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 0,
					max_count	: 2,
					entity	: "data/entities/animals/scavenger_smg.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.002,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tank_super.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_heal.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_lasership.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_leader.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 0,
					max_count	: 1,
					entity	: "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 0,
					max_count	: 1,
					entity	: "data/entities/animals/coward.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner_hell.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper_hell.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				"data/entities/animals/drunk/scavenger_grenade.xml",
				"data/entities/animals/drunk/scavenger_smg.xml",
			],
			spawn_check : "jussi"
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 0,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_smg.xml",
				},
			],
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/sniper.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/drunk/miner.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/drunk/shotgunner.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.01,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.002,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/scavenger_heal.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 0,
					max_count	: 1,
					entity	: "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_smg.xml",
				},
			],
			spawn_check : "jussi",
		},
	],
	big: [
		{
			prob   		: 0.3,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	:  [
				"data/entities/animals/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 1,
			entities 	:  [
				"data/entities/animals/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/coward.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_heal.xml"
		},
		{
			prob   		: 0.005,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entities 	:  [
				"data/entities/animals/scavenger_clusterbomb.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 1,
					entity : "data/entities/animals/scavenger_heal.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/drone_lasership.xml",
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/coward.xml",
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
			]
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/hpcrystal.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.075,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot_super.xml",
			ngpluslevel : 3,
		},
		{
			prob   		: 2.1,
			min_count	: 1,
			max_count	: 1,
			entities 	:  [
				"data/entities/animals/drunk/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/drunk/scavenger_smg.xml",
				},
			],
			spawn_check : "jussi",
		},
		{
			prob   		: 2.1,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 1,
			entities 	:  [
				"data/entities/animals/drunk/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/drunk/scavenger_smg.xml",
				},
			],
			spawn_check : "jussi",
		},
		{
			prob   		: 2.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/scavenger_heal.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 2.02,
			min_count	: 1,
			max_count	: 1,
			entities 	:  [
				"data/entities/animals/drunk/scavenger_clusterbomb.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/drunk/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 1,
					entity : "data/entities/animals/drunk/scavenger_heal.xml",
				},
			],
			spawn_check : "jussi",
		},
	],
	unique: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.002,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/healerdrone_physics.xml"
		},
	],
	unique2: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.6,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/scavenger_grenade.xml"
		},
		{
			prob   		: 0.6,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/scavenger_smg.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_heal.xml"
		},
		{
			prob   		: 2.6,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/drunk/scavenger_grenade.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 2.6,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/drunk/scavenger_smg.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 2.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/sniper.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 2.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/scavenger_heal.xml",
			spawn_check : "jussi",
		},
	],
	turret: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1, 
			entity 	: "data/entities/animals/turret_right.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1, 
			entity 	: "data/entities/animals/turret_left.xml"
		},
	]
};

const RAINFOREST_ENEMIES = {
	small: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 2,
			max_count	: 4,
			entity 	: "data/entities/animals/rainforest/fly.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_longleg.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/rainforest/shooterflower.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/scavenger_poison.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/scavenger_clusterbomb.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/projectiles/mine.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/bloom.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/shaman.xml"
		},
		{
			prob   		: 0.06,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/wizard_twitchy.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/rainforest/scavenger_smg.xml",
				"data/entities/animals/rainforest/scavenger_grenade.xml",
				"data/entities/animals/rainforest/coward.xml",
			],
		},
	],
	big: [
		{
			prob   		: 0.6,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/rainforest/fungus.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_longleg.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/bloom.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/scavenger_mine.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/rainforest/scavenger_poison.xml",
				"data/entities/animals/rainforest/scavenger_clusterbomb.xml",
			],
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/rainforest/scavenger_poison.xml",
				"data/entities/animals/rainforest/scavenger_clusterbomb.xml",
				"data/entities/animals/rainforest/scavenger_heal.xml",
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/projectiles/mine.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/shooterflower.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/spearbot.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_hearty.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 1,
			entities 	: [
				"data/entities/animals/rainforest/scavenger_poison.xml",
				"data/entities/animals/rainforest/scavenger_clusterbomb.xml",
				"data/entities/animals/rainforest/scavenger_leader.xml",
				"data/entities/animals/rainforest/coward.xml",
			],
		},
	],
	unique: [
		{
			prob   		: 1.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/physics_cocoon.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/projectiles/mine.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/shooterflower.xml"
		},
	],
	unique2: [
		{
			prob   		: 1.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/lukki_eggs.xml"
		},
	],
	large: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/shooterflower.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/rainforest/fungus.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/rainforest/bloom.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_longleg.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 2,
					entity : "data/entities/animals/rainforest/scavenger_clusterbomb.xml",
				},
				{
					min_count	: 1,
					max_count	: 2,
					entity : "data/entities/animals/rainforest/scavenger_poison.xml",
				},
				"data/entities/animals/rainforest/scavenger_leader.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/projectiles/mine.xml"
		},
	],
	scavengers: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 2,
			entities 	:  [
				"data/entities/animals/rainforest/scavenger_smg.xml",
				"data/entities/animals/rainforest/scavenger_grenade.xml"
			]
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/flamer.xml"
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/sniper.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/scavenger_leader.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/projectiles/mine.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/rainforest/scavenger_mine.xml"
		},
	],
	nest: [
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: "data/entities/buildings/flynest.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,    
			entity 	: "data/entities/buildings/spidernest.xml"
		},
	],
};

const VAULT_ENEMIES = {
	small: [
		{
			prob   		: 0.8,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/vault/drone_physics.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/lasershooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 		: "data/entities/animals/vault/roboguard.xml",
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/assassin.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/tentacler.xml"
		},
		{
			prob   		: 0.12,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/vault/tentacler_small.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/tentacler_small.xml",
				"data/entities/animals/vault/tentacler.xml",
			]
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/acidshooter.xml"
		},
		{
			prob   		: 0.18,
			min_count	: 3,
			max_count	: 5,
			entity 	: "data/entities/animals/vault/blob.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/vault/bigzombie.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/scavenger_mine.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				"data/entities/animals/vault/sniper.xml",
				"data/entities/animals/vault/flamer.xml",
			]
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/drone_lasership.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 		: "data/entities/animals/monk.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 		: "data/entities/animals/vault/thunderskull.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/sniper.xml",
				"data/entities/animals/vault/coward.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/vault/scavenger_glue.xml",
		},
	],
	big: [
		{
			prob   		: 0.8,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/vault/firemage.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/thundermage.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_invis.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_shield.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/roboguard.xml",
				"data/entities/animals/vault/healerdrone_physics.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/wizard_dark.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_swapper.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_twitchy.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/maggot.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 3,
					entity 	: "data/entities/animals/vault/scavenger_smg.xml"
				},
				{
					min_count	: 1,
					max_count	: 3,
					entity 	: "data/entities/animals/vault/scavenger_grenade.xml"
				},
				{
					min_count	: 0,
					max_count	: 3,
					entity 	: "data/entities/animals/vault/scavenger_glue.xml"
				},
				"data/entities/animals/vault/scavenger_leader.xml",
				"data/entities/animals/vault/scavenger_heal.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/tank.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/tank_rocket.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/tank_super.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/missilecrab.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/spearbot.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/flamer.xml",
				"data/entities/animals/vault/icer.xml",
				"data/entities/animals/vault/healerdrone_physics.xml",
			]
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/roboguard.xml",
				"data/entities/animals/vault/healerdrone_physics.xml",
				"data/entities/animals/vault/coward.xml",
			]
		},
		{
			prob   		: 0.075,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot_super.xml",
			ngpluslevel : 2,
		},
	],
	turret: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1, 
			entity 	: "data/entities/animals/vault/turret_right.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1, 
			entity 	: "data/entities/animals/vault/turret_left.xml"
		},
	]
};

const CRYPT_ENEMIES = {
	small: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/phantom_a.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 3,
			max_count	: 4,
			entity 	: "data/entities/animals/crypt/skullrat.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/phantom_b.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/skullfly.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/crypt/tentacler.xml"
		},
		{
			prob   		: 0.15,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/crypt/tentacler_small.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/crypt/tentacler_small.xml",
				"data/entities/animals/crypt/tentacler.xml",
			]
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/necromancer.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/acidshooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/crystal_physics.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/maggot.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/failed_alchemist.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_homing.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_weaken.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/weakspirit.xml",
			ngpluslevel : 1,
		},
	],
	big: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/thundermage.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/worm.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/acidshooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/phantom_a.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/worm_skull.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/skullfly.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/crypt/skullrat.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/phantom_b.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/crypt/phantom_b.xml",
				"data/entities/animals/crypt/phantom_a.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/crystal_physics.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/crypt/wizard_tele.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/wizard_dark.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/wizard_poly.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/wizard_returner.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/wizard_neutral.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_hearty.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_swapper.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/barfer.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith_glowing.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/enlightened_alchemist.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/failed_alchemist_b.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necromancer_shop.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/ghoul.xml",
			ngpluslevel : 1,
		},
	],
	scorpions: [
		{
			prob   		: 0.7,
			min_count	: 1,
			max_count	: 1,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scorpion.xml"
		},
	],
	unique: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.5,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/arrowtrap_right.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/firetrap_right.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/thundertrap_right.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/spittrap_right.xml"
		},
	],
	large: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.5,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/arrowtrap_left.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/firetrap_left.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/thundertrap_left.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/spittrap_left.xml"
		},
	],
	ghost_crystal: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entities : [
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/ghost.xml",
				},
				"data/entities/buildings/ghost_crystal.xml",
			]
		},
	],
	scavengers: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 3,
			entities 	: [
				"data/entities/animals/scavenger_smg.xml",
				"data/entities/animals/scavenger_grenade.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_leader.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_clusterbomb.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_poison.xml"
		},
	],
};

const RAINFOREST_DARK_ENEMIES = {
	small: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_creepy_long.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/lurker.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_dark.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/wizard_weaken.xml"
		},
		{
			prob   		: 0.06,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/wizard_twitchy.xml"
		},
		{
			prob   		: 0.06,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/wizard_homing.xml"
		},
	],
	big: [
		{
			prob   		: 0.6,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/rainforest/fungus.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/fungus_big.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_dark.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lurker.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_dark.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_hearty.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot_super.xml",
			ngpluslevel : 2,
		},
	],
	unique: [
		{
			prob   		: 1.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lurker.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_dark.xml"
		},
	],
	unique2: [
		{
			prob   		: 1.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/lukki_eggs.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_dark.xml"
		},
	],
	large: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lurker.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/rainforest/fungus.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/fungus_big.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/lukki/lukki_dark.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/crypt/skullfly.xml"
		},
	],
};

const PYRAMID_ENEMIES = {
	small: [
		{
			prob   		: 2.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/skullrat.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/skullfly.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/acidshooter.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scorpion.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/alchemist.xml"
		},
		{
			prob   		: 0.005,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage_big.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/thunderskull.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wizard_twitchy.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wizard_hearty.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wizard_weaken.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/ethereal_being.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/hpcrystal.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/confusespirit.xml",
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/berserkspirit.xml",
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/weakspirit.xml",
		},
	],
	big: [
		{
			prob   		: 2.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/acidshooter.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/phantom_a.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/skullfly.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/skullrat.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/phantom_b.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scorpion.xml"
		},
	],
	scorpions: [
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scorpion.xml"
		},
	],
	unique: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/arrowtrap_right.xml"
		},
	],
	large: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/arrowtrap_left.xml"
		},
	],
	scavengers: [
		{
			prob   		: 0.9,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 3,
			entities 	: [
				"data/entities/animals/scavenger_smg.xml",
				"data/entities/animals/scavenger_grenade.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_leader.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_clusterbomb.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_poison.xml"
		},
	],
};

const LIQUIDCAVE_ENEMIES = {
	small: [
		{
			prob   		: 0.2,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/failed_alchemist.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/enlightened_alchemist.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_returner.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_tele.xml",
				"data/entities/animals/wizard_dark.xml"
			],
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_hearty.xml",
				"data/entities/animals/wizard_swapper.xml"
			],
			ngpluslevel : 1,
		},
	],
	big: [
		{
			prob   		: 0.2,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/failed_alchemist.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/enlightened_alchemist.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shaman.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/failed_alchemist_b.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_twitchy.xml",
				"data/entities/animals/wizard_poly.xml"
			],
			ngpluslevel : 2,
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/hpcrystal.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot_super.xml",
			ngpluslevel : 2,
		},
	],
	statues: [
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 1,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_01.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_02.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_03.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_04.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_05.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_06.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_07.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_08.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_09.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_10.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_11.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/props/statues/statue_rock_12.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/statue_trap_right.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/statue_trap_left.xml"
		},
	]
};

const MEAT_ENEMIES = {
	small: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/shotgunner_hell.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner_hell.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 4,
			entity 	: "data/entities/animals/rat.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper_hell.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/meatmaggot.xml"
		},
	],
	big: [
		{
			prob   		: 0.3,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/worm_big.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/worm.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/meatmaggot.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 		: "data/entities/animals/wizard_hearty.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 		: "data/entities/animals/slimespirit.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/hpcrystal.xml",
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/easter/sniper.xml",
			spawn_check : "august24"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/bloodcrystal_physics.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot.xml"
		},
		{
			prob   		: 0.06,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 1,
			entity 	: "data/entities/animals/necrobot_super.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/failed_alchemist.xml"
		},
	],
	unique: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_tele.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_dark.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_swapper.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necromancer.xml"
		},
	],
	unique2: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 3,
			max_count	: 4,
			entity 	: "data/entities/animals/sniper_hell.xml"
		}
	],
	mouth: [
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/wallmouth.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/walleye.xml"
		},
		{
			prob   		: 1.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: ""
		},
	],
};

const WIZARDCAVE_ENEMIES = {
	small: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/firemage.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/thundermage.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/icemage.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_tele.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_poly.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_dark.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_swapper.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/wizard_returner.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_hearty.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_twitchy.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_weaken.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_homing.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/barfer.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/failed_alchemist.xml"
		},
	],
	big: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 2,
			max_count	: 3,
			entity 	: "data/entities/animals/thundermage.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_tele.xml",
				"data/entities/animals/wizard_dark.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_dark.xml",
				"data/entities/animals/wizard_poly.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_poly.xml",
				"data/entities/animals/wizard_swapper.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_swapper.xml",
				"data/entities/animals/wizard_hearty.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_hearty.xml",
				"data/entities/animals/wizard_twitchy.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_twitchy.xml",
				"data/entities/animals/wizard_neutral.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_neutral.xml",
				"data/entities/animals/wizard_returner.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_returner.xml",
				"data/entities/animals/wizard_weaken.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_weaken.xml",
				"data/entities/animals/wizard_homing.xml"
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_homing.xml",
				"data/entities/animals/wizard_tele.xml"
			],
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/wizard_tele.xml",
				"data/entities/animals/wizard_dark.xml",
				"data/entities/animals/wizard_poly.xml",
				"data/entities/animals/wizard_swapper.xml",
				"data/entities/animals/wizard_neutral.xml",
				"data/entities/animals/wizard_twitchy.xml",
				"data/entities/animals/wizard_returner.xml",
				"data/entities/animals/wizard_hearty.xml",
				"data/entities/animals/wizard_weaken.xml",
				"data/entities/animals/wizard_homing.xml"
			],
		},
	],
	scorpions: [
		{
			prob   		: 0.7,
			min_count	: 1,
			max_count	: 1,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scorpion.xml"
		},
	],
	unique: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.5,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/arrowtrap_right.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/firetrap_right.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/thundertrap_right.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/spittrap_right.xml"
		},
	],
	large: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.5,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/arrowtrap_left.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/firetrap_left.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/thundertrap_left.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/spittrap_left.xml"
		},
	],
	ghost_crystal: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entities : [
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/ghost.xml",
				},
				"data/entities/buildings/ghost_crystal.xml",
			]
		},
	],
	scavengers: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 3,
			entities 	: [
				"data/entities/animals/scavenger_smg.xml",
				"data/entities/animals/scavenger_grenade.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_leader.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_clusterbomb.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_poison.xml"
		},
	],
};

const VAULT_FROZEN_ENEMIES = {
	small: [
		{
			prob   		: 0.8,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/vault/drone_physics.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/lasershooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 		: "data/entities/animals/vault/roboguard.xml",
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/assassin.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/acidshooter.xml"
		},
		{
			prob   		: 0.18,
			min_count	: 3,
			max_count	: 5,
			entity 	: "data/entities/animals/vault/blob.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/vault/bigzombie.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/scavenger_mine.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_invis.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/icer.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/icemage.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/thunderskull.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_shield.xml"
		},
		{
			prob   		: 0.002,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/ultimate_killer.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_twitchy.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 4,
			entity 	: "data/entities/animals/vault/scavenger_glue.xml",
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/scavenger_leader.xml",
				"data/entities/animals/vault/scavenger_smg.xml",
				"data/entities/animals/vault/scavenger_grenade.xml",
				"data/entities/animals/vault/scavenger_glue.xml",
				"data/entities/animals/vault/coward.xml",
			],
		},
	],
	big: [
		{
			prob   		: 0.8,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/vault/firemage.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/thundermage.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage_big.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/roboguard.xml",
				"data/entities/animals/vault/healerdrone_physics.xml",
				"data/entities/animals/scavenger_invis.xml"
			],
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 3,
					entity 	: "data/entities/animals/vault/scavenger_smg.xml"
				},
				{
					min_count	: 1,
					max_count	: 3,
					entity 	: "data/entities/animals/vault/scavenger_grenade.xml"
				},
				{
					min_count	: 0,
					max_count	: 1,
					entity 	: "data/entities/animals/vault/coward.xml"
				},
				"data/entities/animals/vault/scavenger_leader.xml",
				"data/entities/animals/vault/scavenger_heal.xml",
				"data/entities/animals/scavenger_invis.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/tank_rocket.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/tank_super.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_shield.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/vault/missilecrab.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/spearbot.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot_super.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_hearty.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_weaken.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/icer.xml",
				"data/entities/animals/vault/healerdrone_physics.xml",
			]
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/vault/missilecrab.xml",
				"data/entities/animals/drone_shield.xml",
			]
		},
	],
	turret: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1, 
			entity 	: "data/entities/animals/vault/turret_right.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1, 
			entity 	: "data/entities/animals/vault/turret_left.xml"
		},
	],
};

const FUNGIFOREST_ENEMIES = {
	small: [
		{
			prob   		: 2.2,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/fungus.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/fungus_big.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/ant.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 2,
			max_count	: 4,
			entity 	: "data/entities/animals/blob.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 4,
			entity 	: "data/entities/animals/frog_big.xml",
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fungus_giga.xml",
		},
	],
	big: [
		{
			prob   		: 2.7,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/fungus.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fungus_giga.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 3,
			max_count	: 5,
			entity 	: "data/entities/animals/blob.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/alchemist.xml"
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/fungus_big.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 3,
					entity	: "data/entities/animals/fungus.xml",
				},
				{
					min_count	: 1,
					max_count	: 1,
					entity	: "data/entities/animals/fungus_big.xml",
				},
			],
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 3,
					entity	: "data/entities/animals/fungus.xml",
				},
				{
					min_count	: 1,
					max_count	: 1,
					entity	: "data/entities/animals/fungus_big.xml",
				},
				{
					min_count	: 1,
					max_count	: 1,
					entity	: "data/entities/animals/fungus_giga.xml",
				},
			],
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_shield.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/confusespirit.xml",
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/berserkspirit.xml",
			ngpluslevel : 1,
		},
	],
};

const SANDCAVE_ENEMIES = {
	small: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				"data/entities/animals/scavenger_grenade.xml",
				"data/entities/animals/scavenger_smg.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 0,
					max_count 	: 1,
					entity : "data/entities/animals/scavenger_heal.xml",
				},
			]
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_clusterbomb.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_mine.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_poison.xml"
		},
		{
			prob   		: 0.09,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_leader.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_invis.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner_hell.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper_hell.xml",
			ngpluslevel : 2,
		},
	],
	big: [
		{
			prob   		: 0.3,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 0,
					max_count 	: 1,
					entity : "data/entities/animals/scavenger_heal.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/flamer.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wizard_tele.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wizard_dark.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wizard_swapper.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/scavenger_clusterbomb.xml",
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 0,
					max_count 	: 1,
					entity : "data/entities/animals/scavenger_heal.xml",
				},
			]
		},
	],
	unique: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/tank.xml",
				"data/entities/animals/healerdrone_physics.xml",
			],
		},
	],
	unique2: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.6,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/scavenger_grenade.xml"
		},
		{
			prob   		: 0.6,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/scavenger_smg.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper.xml"
		},
	],
};

const ROBOBASE_ENEMIES = {
	small: [
		{
			prob   		: 0.8,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/roboguard_big.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/basebot_sentry.xml"
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/basebot_hidden.xml"
		},
		{
			prob   		: 0.12,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/basebot_neutralizer.xml"
		},
		{
			prob   		: 0.12,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/basebot_soldier.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/vault/scavenger_glue.xml",
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/robobase/healerdrone_physics.xml"
		},
	],
	big: [
		{
			prob   		: 0.8,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/robobase/drone_shield.xml",
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/basebot_hidden.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/basebot_neutralizer.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/basebot_sentry.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/basebot_soldier.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/robobase/tank_super.xml",
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot.xml",
		},
		{
			prob   		: 0.08,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot_super.xml",
		},
	],
	turret: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1, 
			entity 	: "data/entities/animals/vault/turret_right.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1, 
			entity 	: "data/entities/animals/vault/turret_left.xml"
		},
	]
};

const CLOUDS_ENEMIES = {
	small: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 4,
			entity 	: "data/entities/animals/wraith_glowing.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith_storm.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/thundermage.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage_big.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_tele.xml"
		},
		{
			prob   		: 0.4,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_swapper.xml"
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/skycrystal_physics.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/spearbot.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_neutral.xml"
		},
		{
			prob   		: 0.07,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_weaken.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_homing.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wizard_hearty.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/ethereal_being.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/weakspirit.xml",
			ngpluslevel : 2,
		},
	],
};

const LAKE_ENEMIES = {
	small: [
		{
			prob   		: 1.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 5,
			entity 	: "data/entities/animals/fish.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/fish_large.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/eel.xml"
		},
	],
};

const HELL_ENEMIES = {
	small: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/the_end/gazer.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/the_end/spitmonster.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/the_end/bloodcrystal_physics.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/the_end/worm_end.xml"
		},
		{
			prob   		: 0.004,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith.xml"
		},
		{
			prob   		: 0.001,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith_glowing.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/thunderskull.xml"
		},
	],
	unique: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/arrowtrap_right.xml"
		},
	],
	large: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/arrowtrap_left.xml"
		},
	]
};

const HEAVEN_ENEMIES = {
	small: [
		{
			prob   		: 0.4,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/the_end/skygazer.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/the_end/spearbot.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/the_end/skycrystal_physics.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/the_end/worm_skull.xml"
		},
		{
			prob   		: 0.004,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith_storm.xml"
		},
		{
			prob   		: 0.001,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith_glowing.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/thunderskull.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/wizard_tele.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage_big.xml"
		},
	],
	big: [
		{
			prob   		: 1.8,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wraith_glowing.xml"
		},
	],
	unique: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 2,		
			entity 	: "data/entities/buildings/arrowtrap_right.xml"
		},
	],
	large: [
		{
			prob   		: 0.1,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,  
			offset_x	: 1,
			entity 	: "data/entities/buildings/arrowtrap_left.xml"
		},
	],
};

const SNOWCHASM_ENEMIES = {
	small: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/iceskull.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_smg.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_grenade.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thunderskull.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/ethereal_being.xml"
		},
	],
	big: [
		{
			prob   		: 0.5,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/icemage.xml"
		},
		{
			prob   		: 0.15,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/phantom_a.xml"
		},
		{
			prob   		: 0.15,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/phantom_b.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/thundermage_big.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/snowcrystal.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/hpcrystal.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/ethereal_being.xml"
		},
		{
			prob   		: 0.2,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/ghost_crystal.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/weakspirit.xml",
			ngpluslevel : 2,
		},
	],
	unique: [
		{
			prob   		: 0.0,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.5,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/slimeshooter.xml"
		},
		{
			prob   		: 0.3,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/acidshooter.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/giantshooter.xml"
		},
	]
};

const WATCHTOWER_ENEMIES = {
	small: [
		{
			prob   		: 0.2,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				"data/entities/animals/scavenger_grenade.xml",
				"data/entities/animals/scavenger_smg.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 0,
					max_count	: 2,
					entity	: "data/entities/animals/scavenger_smg.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/miner.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/shotgunner.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.01,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.002,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/tank_super.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_heal.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_leader.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 0,
					max_count	: 1,
					entity	: "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 0,
					max_count	: 1,
					entity	: "data/entities/animals/coward.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/shotgunner_hell.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/sniper_hell.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				"data/entities/animals/drunk/scavenger_grenade.xml",
				"data/entities/animals/drunk/scavenger_smg.xml",
			],
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 0,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_smg.xml",
				},
			],
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/sniper.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/drunk/miner.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/drunk/shotgunner.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.05,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.01,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.002,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/scavenger_heal.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/items/easter/beer_bottle.xml",
			spawn_check : "jussi"
		},
		{
			prob   		: 1.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 0,
					max_count	: 1,
					entity	: "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_smg.xml",
				},
			],
			spawn_check : "jussi",
		},
	],
	big: [
		{
			prob   		: 0.3,
			min_count	: 0,
			max_count	: 0,
			entity 	: ""
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 1,
			entities 	: [
				"data/entities/animals/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/coward.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank.xml"
		},
		{
			prob   		: 0.03,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_rocket.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/scavenger_heal.xml"
		},
		{
			prob   		: 0.005,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/tank_super.xml"
		},
		{
			prob   		: 0.02,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/scavenger_clusterbomb.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 1,
					entity : "data/entities/animals/scavenger_heal.xml",
				},
			]
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/coward.xml",
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/scavenger_smg.xml",
				},
			]
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/buildings/hpcrystal.xml",
			ngpluslevel : 1,
		},
		{
			prob   		: 0.075,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/necrobot_super.xml",
			ngpluslevel : 3,
		},
		{
			prob   		: 2.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/drunk/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/drunk/scavenger_smg.xml",
				},
			],
			spawn_check : "jussi",
		},
		{
			prob   		: 2.1,
			min_count	: 1,
			max_count	: 1,
			ngpluslevel	: 1,
			entities 	: [
				"data/entities/animals/drunk/scavenger_leader.xml",
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 2,
					entity : "data/entities/animals/drunk/scavenger_smg.xml",
				},
			],
			spawn_check : "jussi",
		},
		{
			prob   		: 2.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/scavenger_heal.xml",
			spawn_check : "jussi",
		},
		{
			prob   		: 2.02,
			min_count	: 1,
			max_count	: 1,
			entities 	:  [
				"data/entities/animals/drunk/scavenger_clusterbomb.xml",
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count 	: 3,
					entity : "data/entities/animals/drunk/scavenger_smg.xml",
				},
				{
					min_count	: 1,
					max_count 	: 1,
					entity : "data/entities/animals/drunk/scavenger_heal.xml",
				},
			],
			spawn_check : "jussi",
		},
	]
};

const LAKE_STATUE_ENEMIES = {
	fish: [
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/fish.xml"
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: ""
		},
	],
	small: [
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: ""
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/deer.xml"
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 3,
			entity 	: "data/entities/animals/duck.xml"
		},
		{
			prob   		: 1.0,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/elk.xml"
		},
		{
			prob   		: 1.0,
			min_count	: 2,
			max_count	: 5,
			entity 	: "data/entities/animals/sheep.xml"
		},
		{
			prob   		: 0.05,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/wolf.xml"
		},
	],
	hiisi: [
		{
			prob   		: 0.3,
			min_count	: 2,
			max_count	: 2,
			entity 	: "data/entities/animals/drunk/miner_weak.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 2,
			max_count	: 2,
			entity 	: "data/entities/animals/drunk/miner_fire.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/shotgunner.xml"
		},
			{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				"data/entities/animals/drunk/miner.xml",
				"data/entities/animals/drunk/miner.xml",
				"data/entities/animals/drunk/shotgunner.xml",
			]
		},
		{
			prob   		: 0.12,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/shotgunner.xml"
		},
			{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				"data/entities/animals/drunk/scavenger_grenade.xml",
				"data/entities/animals/drunk/scavenger_smg.xml",
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entities 	: [
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 0,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_smg.xml",
				},
			]
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/sniper.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/drunk/miner.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 2,
			entity 	: "data/entities/animals/drunk/shotgunner.xml"
		},
		{
			prob   		: 0.04,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/scavenger_heal.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drone_lasership.xml"
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entity 	: "data/entities/animals/drunk/scavenger_leader.xml",
			ngpluslevel : 2,
		},
		{
			prob   		: 0.1,
			min_count	: 1,
			max_count	: 1,
			entities 	: [
				{
					min_count	: 0,
					max_count	: 1,
					entity	: "data/entities/animals/drunk/scavenger_grenade.xml",
				},
				{
					min_count	: 1,
					max_count	: 2,
					entity	: "data/entities/animals/drunk/scavenger_smg.xml",
				},
			]
		},
	]
};

export const TOWER_ENEMIES = [
	"acidshooter", "alchemist", "ant", "assassin", "barfer", "bat", "bigbat", "bigfirebug", "bigzombie", "blob", "bloodcrystal_physics", "bloom", "chest_mimic", "coward", "crystal_physics", "drone_physics",  "drone_shield", "enlightened_alchemist", "failed_alchemist", "failed_alchemist_b", "firebug", "firemage", "fireskull", "flamer", "fly", "frog", "frog_big", "fungus", "fungus_big", "fungus_giga", "gazer", "ghoul", "giant", "giantshooter", "healerdrone_physics", "icemage", "icer", "iceskull", "lasershooter", "longleg", "maggot", "miner", "miner_fire", "missilecrab", "monk", "necromancer", "necromancer_shop", "phantom_a", "phantom_b", "rat", "roboguard", "scavenger_clusterbomb", "scavenger_heal", "scavenger_grenade", "scavenger_leader", "scavenger_mine", "scavenger_poison", "scavenger_smg", "shooterflower", "shotgunner", "skullfly", "skullrat", "slimeshooter", "sniper", "spitmonster", "statue_physics", "tank", "tank_rocket", "tank_super", "tentacler", "tentacler_small", "thundermage", "thundermage_big", "thunderskull", "turret_left", "turret_right", "wizard_dark", "wizard_hearty", "wizard_neutral", "wizard_poly", "wizard_returner", "wizard_swapper", "wizard_tele", "wizard_twitchy", "wizard_weaken", "wizard_homing", "wolf", "wraith", "wraith_glowing", "wraith_storm", "zombie", "skycrystal_physics", "scavenger_shield", "spearbot", "statue", "goblin_bomb", "snowcrystal", "hpcrystal"
];

export const BIOME_ENEMY_MAP = {
	coalmine: COALMINE_ENEMIES,
	coalmine_alt: COALMINE_ALT_ENEMIES,
	excavationsite: EXCAVATIONSITE_ENEMIES,
	fungicave: FUNGICAVE_ENEMIES,
	snowcave: SNOWCAVE_ENEMIES,
	wandcave: WANDCAVE_ENEMIES,
	snowcastle: SNOWCASTLE_ENEMIES,
	rainforest: RAINFOREST_ENEMIES,
	rainforest_open: RAINFOREST_ENEMIES,
	rainforest_dark: RAINFOREST_DARK_ENEMIES,
	vault: VAULT_ENEMIES,
	crypt: CRYPT_ENEMIES,
	vault_frozen: VAULT_FROZEN_ENEMIES,
	clouds: CLOUDS_ENEMIES,
	lake_deep: LAKE_ENEMIES,
	the_end: HELL_ENEMIES,
	the_sky: HEAVEN_ENEMIES,
	winter_caves: SNOWCHASM_ENEMIES,
	biome_watchtower: WATCHTOWER_ENEMIES,
	fungiforest: FUNGIFOREST_ENEMIES,
	sandcave: SANDCAVE_ENEMIES,
	liquidcave: LIQUIDCAVE_ENEMIES,
	robobase: ROBOBASE_ENEMIES,
	wizardcave: WIZARDCAVE_ENEMIES,
	meat: MEAT_ENEMIES,
	lake_statue: LAKE_STATUE_ENEMIES,
	pyramid: PYRAMID_ENEMIES,
};