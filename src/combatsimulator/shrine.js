import Buff from "./buff";
import shrineDetailMap from "./data/shrineDetailMap.json";

// Shrines are permanent, per-character bonuses that apply to all combat. Every level adds a fixed
// amount to each of the shrine's buff types, expressed through the regular Buff level scaling:
// boost + (N - 1) * boostLevelBonus.
class Shrine {
    constructor(hrid, level) {
        this.hrid = hrid;
        this.level = level;

        let gameShrine = shrineDetailMap[this.hrid];
        if (!gameShrine) {
            throw new Error("No shrine found for hrid: " + this.hrid);
        }

        this.buffs = gameShrine.buffs.map((buff) => new Buff(buff, level));
    }

    // levels: { <shrineHrid>: level }. Unknown hrids and non-positive levels are ignored.
    static buffsFromLevels(levels) {
        if (!levels) {
            return [];
        }

        return Object.entries(levels)
            .filter(([hrid, level]) => shrineDetailMap[hrid] && level > 0)
            .flatMap(([hrid, level]) => new Shrine(hrid, Number(level)).buffs);
    }
}

export default Shrine;
