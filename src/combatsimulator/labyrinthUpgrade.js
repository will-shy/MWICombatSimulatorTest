import Buff from "./buff";
import labyrinthUpgradeDetailMap from "./data/labyrinthUpgradeDetailMap.json";

// Labyrinth shop upgrades are permanent, per-character bonuses that only apply inside a labyrinth.
// Every level adds a flat 1% to a single buff type, so level N is expressed through the regular
// Buff level scaling: boost + (N - 1) * boostLevelBonus.
class LabyrinthUpgrade {
    constructor(hrid, level) {
        this.hrid = hrid;
        this.level = level;

        let gameLabyrinthUpgrade = labyrinthUpgradeDetailMap[this.hrid];
        if (!gameLabyrinthUpgrade) {
            throw new Error("No labyrinth upgrade found for hrid: " + this.hrid);
        }

        this.buffs = gameLabyrinthUpgrade.buffs.map((buff) => new Buff(buff, level));
    }

    // levels: { <labyrinthUpgradeHrid>: level }. Unknown hrids and non-positive levels are ignored.
    static buffsFromLevels(levels) {
        if (!levels) {
            return [];
        }

        return Object.entries(levels)
            .filter(([hrid, level]) => labyrinthUpgradeDetailMap[hrid] && level > 0)
            .flatMap(([hrid, level]) => new LabyrinthUpgrade(hrid, Number(level)).buffs);
    }
}

export default LabyrinthUpgrade;
