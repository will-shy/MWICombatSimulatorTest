import Monster from "./monster";
import labyrinthCrateDetailMap from "./data/labyrinthCrateDetailMap.json"

class Labyrinth{
    constructor(monsterHrid, roomLevel, crates=[]) {
        this.monsterHrid = monsterHrid;
        this.roomLevel = roomLevel;

        this.buffs = [];
        if (crates) {
            for (let crate of crates) {
                this.buffs = this.buffs.concat(labyrinthCrateDetailMap[crate]);
            }
        }

        this.attemptCount = 0;
    }

    getMonster () {
        this.attemptCount ++;
        let monster = new Monster(this.monsterHrid, 0, this.roomLevel);
        // Labyrinth monsters don't roll a random spawn cooldown: every ability
        // starts at exactly half its cooldown. See combatUnit.resetCooldowns().
        monster.fixedStartCooldown = true;
        return [monster];
    }

    updateEnconterStartTime (enconterStartTime) {
        this.enconterStartTime = enconterStartTime;
    }
    
    checkTimeout (currentTime) {
        return currentTime - this.enconterStartTime > 120 * 1e9;
    }

}

export default Labyrinth;
