/*
 * Marble Blast Rating Race
 * Speedrun because I lost data and had no backup L.O.L.! ! !
 */

import path from "path";
import express from "express";
const app = express();

const PORT = 7800;
const POLL_INTERVAL = 15 * 1000; // milliseconds

interface Mission {
	id: number;
	game_id: number;
	game_name: string; // Added by us
	difficulty_id: number;
	difficulty_name: string; // Added by us
	name: string;
	// I don't think we care about the rest
}

interface Player {
	username: string;
	name: string;
	startTime: Date | undefined;
	endTime: Date | undefined;
	scores: Record<string, Record<string, Record<number, Score | null>>>;
	totals: {total: number, games: Record<string, {total: number, difficulties: Record<string, number>}>};
	rank: number;
}

interface Score {
	id: number;
	mission_id: number;
	username: string;
	name: string;
	score: number;
	score_type: "time" | "score";
	total_bonus: number;
	rating: number;
	timestamp: Date;
}


/*
 * Get level data from marbleblast.com
 */

let missionReference: Record<number, Mission> | undefined = undefined;

async function getMissions(): Promise<Record<string, Mission> | undefined> {
	let missions: Record<string, Mission> = {}
	const res = await fetch("https://marbleblast.com/pq/leader/api/Mission/GetMissionList.php?gameType=MultiPlayer");
	if (res.status !== 200)
		return undefined;

	const json = await res.json();

	json.games.forEach((game: any) => {
		game.difficulties.forEach((diff: any) => {
			diff.missions.forEach((mission: Mission) => {
				mission.game_name = game["display"];
				mission.difficulty_name = diff["display"];
				missions[mission.id] = mission;
			});
		});
	});

	return missions;
}

function calcMissions(missionList: Array<number>): Record<string, Record<string, Array<Mission>>> {
	if (missionReference === undefined)
		return {}

	let missions: Record<string, Record<string, Array<Mission>>> = {}
	let lastGame: string | undefined = undefined;
	let lastDifficulty: string | undefined = undefined;
	let currentGame: Record<string, Array<Mission>> | undefined = undefined;
	let currentDifficulty: Array<Mission> | undefined = undefined;

	missionList.forEach(missionId => {
		const mission = (missionReference as Record<number, Mission>)[missionId];
		if (mission == null) {
			console.log("wtf? Missing mission: " + missionId);
			return;
		}
		if (currentGame === undefined || mission.game_name !== lastGame) {
			lastDifficulty = undefined;
			currentDifficulty = undefined;
			lastGame = mission.game_name;
			if (!(lastGame in missions))
				missions[lastGame] = {};
			currentGame = missions[lastGame];
		}
		if (currentDifficulty === undefined || mission.difficulty_name !== lastDifficulty) {
			lastDifficulty = mission.difficulty_name;
			if (!(lastDifficulty in currentGame))
				currentGame[lastDifficulty] = [];
			currentDifficulty = currentGame[lastDifficulty];
		}
		currentDifficulty.push(mission);
	});
	return missions;
}


/*
 * Poll server for scores and calculate ratings
 */

let lastUpdated = new Date("1970-01-01T00:00:00Z");

let missions: Record<string, Record<string, Array<Mission>>>; // {game_name: {difficulty_name: [mission]}}
let scores: Array<Player>;
let startTime: Date;
let endTime: Date;
let exceptions: Array<{user: string, startTime: Date, endTime: Date}>;

function createPlayer(username: string, name: string): Player {
	const player: Player = {
		username: username,
		name: name,
		startTime: undefined,
		endTime: undefined,
		scores: {},
		totals: {total: 0, games: {}},
		rank: -1,
	};
	const ex = exceptions.filter(ex => (ex.user === name))[0];
	if (ex) {
		player.startTime = ex.startTime;
		player.endTime = ex.endTime;
	}
	for (const gameName in missions) {
		player.scores[gameName] = {};
		const game = player.scores[gameName];
		player.totals.games[gameName] = {total: 0, difficulties: {}};
		const gameTotal = player.totals.games[gameName];
		for (const difficultyName in missions[gameName]) {
			game[difficultyName] = {};
			const diff = game[difficultyName];
			gameTotal.difficulties[difficultyName] = 0;
			for (const mission of missions[gameName][difficultyName]) {
				diff[mission.id] = null;
			}
		}
	}
	return player;
}

function calcExceptions(data: Record<string, [string, string]>) {
	const exceptions : Array<{user: string, startTime: Date, endTime: Date}> = [];
	for (const name in data) {
		const ex = data[name];
		exceptions.push({
			user: name,
			startTime: new Date(ex[0] + "Z"),
			endTime: new Date(ex[1] + "Z"),
		});
	}
	return exceptions;
}

function sortScore(a: Score, b: Score): number {
	if (a.score_type !== b.score_type) {
		if (a.score_type === "score")
			return 1;
		else
			return -1;
	}
	if (a.score_type === "score") {
		return b.score - a.score;
	} else /* if (a.score_type === "time") */ {
		return a.score - b.score;
	}
}

function calcScores(scores: Array<Score>): Array<Player> {
	const players: Record<string, Player> = {};
	// Figure out each player's best score for each level
	console.log("Adding scores");
	for (const score of scores) {
		if (!(score.name in players)) {
			players[score.name] = createPlayer(score.username, score.name);
		}
		const player = players[score.name];
		const mission = (missionReference as Record<number, Mission>)[score.mission_id];
		const prevScore = player.scores[mission.game_name][mission.difficulty_name][mission.id];
		if (prevScore === null || sortScore(score, prevScore) < 0) {
			score.timestamp = new Date(score.timestamp + "Z");
			player.scores[mission.game_name][mission.difficulty_name][mission.id] = score;
		}
	}
	// Sum up best scores for each player
	console.log("Summing totals");
	for (const playerName in players) {
		const player = players[playerName];
		for (const gameName in player.scores) {
			const game = player.scores[gameName];
			const gameTotal = player.totals.games[gameName];
			for (const difficultyName in game) {
				const diff = game[difficultyName];
				for (const missionId in diff) {
					const score = diff[missionId];
					if (score) {
						player.totals.total += score.score;
						gameTotal.total += score.score;
						gameTotal.difficulties[difficultyName] += score.score;
					}
				}
			}
		}
	}
	// Sort ratings by who has the most
	console.log("Sorting results");
	const result: Array<Player> = [];
	for (const playerName in players) {
		result.push(players[playerName]);
	}
	result.sort((p1, p2) => {
		return p2.totals.total - p1.totals.total;
	})
	// Assign ranks
	let lastRating = Infinity;
	let lastRank = 0;
	for (let i = 0; i < result.length; i++) {
		const player = result[i];
		if (player.totals.total < lastRating) {
			lastRank = i + 1;
			lastRating = player.totals.total;
		}
		player.rank = lastRank;
	}

	return result;
}

let currentlyPolling = false;
let printedSkipPolling = false;

function shouldPoll(): boolean {
	if (lastUpdated < new Date("1971-01-01T00:00:00Z"))
		return true;

	const currentTime = new Date();

	if (lastUpdated >= startTime && lastUpdated <= endTime)
		return true;
	if (currentTime >= startTime && currentTime <= endTime)
		return true;

	for (const ex of exceptions) {
		if (lastUpdated >= ex.startTime && lastUpdated <= ex.endTime)
			return true;
		if (currentTime >= ex.startTime && currentTime <= ex.endTime)
			return true;
	}

	return false;
}

async function pollScores() {
	if (currentlyPolling) {
		console.warn("Tried polling while already polling!");
		return;
	}

	if (!shouldPoll()) {
		if (!printedSkipPolling)
			console.info("Skipping polling");
		printedSkipPolling = true;
		return;
	}
	printedSkipPolling = false;

	currentlyPolling = true;

	if (!missionReference) {
		console.log("Fetching missions...");
		missionReference = await getMissions();
		if (!missionReference) {
			// ruh roh...
			console.error("Failed to get missions!!");
			currentlyPolling = false;
			return;
		}
	}

	console.log("Fetching scores...");
	const res = await fetch("https://marbleblast.com/pq/leader/api/Score/GetGlobalScoresRatingRace.php");
	if (res.status !== 200) {
		console.error("Failed to get scores!!");
		currentlyPolling = false;
		return;
	}
	const json = await res.json();

	console.log("Extracting metadata");
	startTime = new Date(json.startTime + "Z");
	endTime = new Date(json.endTime + "Z");
	exceptions = calcExceptions(json.exceptions);
	console.log("Building missions");
	missions = calcMissions(json.missionList);
	console.log("Calculating ratings");
	scores = calcScores(json.scores);

	lastUpdated = new Date();
	currentlyPolling = false;
	console.log("Done");
}

setInterval(pollScores, POLL_INTERVAL);
pollScores();


/*
 * Run HTTP server
 */

app.use(express.static(path.join(__dirname, "static")));

app.get("/missions", (req, res) => {
	if (!missions) {
		res.status(500);
		res.json({error: "Please wait lmao"});
		return;
	}
	res.json(missions);
});

app.get("/lastupdated", (req, res) => {
	res.send(lastUpdated);
})

app.get("/meta", (req, res) => {
	res.json({
		startTime: startTime,
		endTime: endTime,
		exceptions: exceptions,
	});
})

app.get("/scores", (req, res) => {
	if (!scores) {
		res.status(500);
		res.json({error: "Please wait lmao"});
		return;
	}
	res.json({
		startTime: startTime,
		endTime: endTime,
		exceptions: exceptions,
		scores: scores,
	});
})

app.get("/playerscores/:player", (req, res) => {
	if (!scores) {
		res.status(500);
		res.json({error: "Please wait lmao"});
		return;
	}
	if (!("player" in req.params)) {
		res.status(400);
		res.json({error: "What player lmao"});
		return;
	}
	for (const player of scores) {
		if (player.name === req.params.player) {
			res.json({
				startTime: startTime,
				endTime: endTime,
				player: player,
			});
			return;
		}
	}
	res.status(404);
	res.json({error: "Player not found"});
})

app.listen(PORT, () => {
	console.log(`Started HTTP server on port ${PORT}`);
});
