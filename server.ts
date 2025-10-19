/*
 * Marble Blast Rating Race
 * Speedrun because I lost data and had no backup L.O.L.! ! !
 */

import path from "path";
import express from "express";
import fs from "fs";
const app = express();

const PORT = 7800;
const POLL_INTERVAL = 15 * 1000; // milliseconds
const NO_MB_COM = false; // If true, don't pull from marbleblast.com

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
	id: number;
	username: string;
	name: string;
	startTime: Date | undefined;
	endTime: Date | undefined;
	scores: Record<string, Record<string, Record<number, Score | null>>>;
	totals: {total: number, games: Record<string, {total: number, difficulties: Record<string, number>}>};
	rank: number;
	latestPB: Date;
	latestRun: Date;
}

interface Score {
	id: number;
	mission_id: number;
	user_id: number;
	username: string;
	name: string;
	score: number;
	score_type: "time" | "score";
	total_bonus: number;
	rating: number;
	gem_count: number;
	gems_1_point: number;
	gems_2_point: number;
	gems_5_point: number;
	gems_10_point: number;
	timestamp: Date;
}


/*
 * Get level data from marbleblast.com
 */

let missionReference: Record<number, Mission> | undefined = undefined;

async function getMissions(): Promise<Record<string, Mission> | undefined> {
	let missions: Record<string, Mission> = {}
	let json;
	if (NO_MB_COM) {
		json = JSON.parse(fs.readFileSync("missions.json").toString());
		if (json === null || typeof(json) !== "object") {
			console.error(`Unable to parse json file missions.json!!`);
			return undefined;
		}
	} else {
		const res = await fetch("https://marbleblast.com/pq/leader/api/Mission/GetMissionList.php?gameType=MultiPlayer");
		if (res.status !== 200)
			return undefined;
		json = await res.json();
	}

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

function calcMissions(missionList: Array<Array<number>>): Record<string, Record<string, Array<Mission>>> {
	if (missionReference === undefined)
		return {}

	let missions: Record<string, Record<string, Array<Mission>>> = {}
	let currentGame: Record<string, Array<Mission>> = {};
	missions["Hunt"] = currentGame;
	let currentDifficulty: Array<Mission> | undefined = undefined;

	missionList.forEach((weekList, index) => {
		currentDifficulty = [];
		const difficultyName = `Week ${index + 1}`;
		currentGame[difficultyName] = currentDifficulty;
		weekList.forEach(missionId => {
			const mission = (missionReference as Record<number, Mission>)[missionId];
			if (mission == null) {
				console.log("wtf? Missing mission: " + missionId);
				return;
			}
			mission.game_name = "Hunt";
			mission.difficulty_name = difficultyName;
			currentDifficulty?.push(mission);
		})
	});
	return missions;
}


/*
 * Poll server for scores and calculate ratings
 */

let lastUpdated = new Date("1970-01-01T00:00:00Z");
let latestPB = new Date("1970-01-01T00:00:00Z");

let missions: Record<string, Record<string, Array<Mission>>>; // {game_name: {difficulty_name: [mission]}}
let scores: Array<Player>;
let startTime: Date;
let endTime: Date;
let exceptions: Array<{user: string, startTime: Date, endTime: Date}>;
let playerAllScores: Record<string, Array<Score>>; // {player_name: [scores]}
let missionTopScores: Record<number, Array<Score>>; // {mission_id: [scores]}

function createPlayer(id: number, username: string, name: string): Player {
	const player: Player = {
		id: id,
		username: username,
		name: name,
		startTime: undefined,
		endTime: undefined,
		scores: {},
		totals: {total: 0, games: {}},
		rank: -1,
		latestPB: new Date("1970-01-01T00:00:00Z"),
		latestRun: new Date("1970-01-01T00:00:00Z"),
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

function calcScores(allScores: Array<Score>): void {
	const players: Record<string, Player> = {};
	// Figure out each player's best score for each level
	console.log("Adding scores");
	for (const score of allScores) {
		if (!(score.name in players)) {
			players[score.name] = createPlayer(score.user_id, score.username, score.name);
		}
		const player = players[score.name];
		const mission = (missionReference as Record<number, Mission>)[score.mission_id];
		const prevScore = player.scores[mission.game_name][mission.difficulty_name][mission.id];
		if (prevScore === null || sortScore(score, prevScore) < 0) {
			score.timestamp = new Date(score.timestamp + "Z");
			player.scores[mission.game_name][mission.difficulty_name][mission.id] = score;
			if (score.timestamp > latestPB)
				latestPB = score.timestamp;
			if (score.timestamp > player.latestPB)
				player.latestPB = score.timestamp;
		}
	}
	// Sum up best scores for each player
	console.log("Summing totals");
	missionTopScores = {};
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
						if (!(missionId in missionTopScores)) {
							missionTopScores[missionId] = [];
						}
						missionTopScores[missionId].push(score);
					}
				}
			}
		}
	}
	// Sort mission top scores
	for (const [missionId, scores] of Object.entries(missionTopScores)) {
		scores.sort(sortScore);
	}
	// Sort ratings by who has the most
	console.log("Sorting results");
	scores = [];
	for (const playerName in players) {
		scores.push(players[playerName]);
	}
	scores.sort((p1, p2) => {
		return p2.totals.total - p1.totals.total;
	})
	// Assign ranks
	let lastRating = Infinity;
	let lastRank = 0;
	for (let i = 0; i < scores.length; i++) {
		const player = scores[i];
		if (player.totals.total < lastRating) {
			lastRank = i + 1;
			lastRating = player.totals.total;
		}
		player.rank = lastRank;
	}
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

	let jsons: any[] = [];

	console.log("Loading previous scores...");
	fs.readdirSync(".").filter(name => (name.startsWith("week") && name.endsWith(".json"))).forEach(name => {
		const json = JSON.parse(fs.readFileSync(name).toString());
		if (json === null || typeof(json) !== "object") {
			console.error(`Unable to parse json file ${name}!!`);
			return;
		}
		console.log(name);
		jsons.push(json);
	});

	let latestJson: any;
	if (NO_MB_COM) {
		latestJson = jsons[jsons.length - 1];
	} else {
		console.log("Fetching scores...");
		const res = await fetch("https://marbleblast.com/pq/leader/api/Score/GetGlobalScoresRatingRace.php");
		if (res.status !== 200) {
			console.error("Failed to get scores!!");
			currentlyPolling = false;
			return;
		}
		latestJson = await res.json();

		jsons.push(latestJson);
	}

	console.log("Extracting metadata");
	startTime = new Date(latestJson.startTime + "Z");
	endTime = new Date(latestJson.endTime + "Z");
	exceptions = calcExceptions(latestJson.exceptions);

	console.log("Building missions");
	const allMissions = jsons.map(json => json.missionList);
	missions = calcMissions(allMissions);

	console.log("Calculating ratings");
	const allScores = jsons.map(json => json.scores).flat();
	calcScores(allScores);

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
	res.json({
		lastUpdated: lastUpdated,
		latestPB: latestPB,
	});
})

app.get("/lastupdated/:playerId", (req, res) => {
	if (!scores) {
		res.status(500);
		res.json({error: "Please wait lmao"});
		return;
	}
	if (!("playerId" in req.params)) {
		res.status(400);
		res.json({error: "What player lmao"});
		return;
	}
	for (const player of scores) {
		if (player.id === Number(req.params.playerId)) {
			res.json({
				lastUpdated: lastUpdated,
				latestPB: player.latestPB,
			});
			return;
		}
	}
	res.status(404);
	res.json({error: "Player not found"});
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

app.get("/playerscores/:playerId", (req, res) => {
	if (!scores) {
		res.status(500);
		res.json({error: "Please wait lmao"});
		return;
	}
	if (!("playerId" in req.params)) {
		res.status(400);
		res.json({error: "What player lmao"});
		return;
	}
	for (const player of scores) {
		if (player.id === Number(req.params.playerId)) {
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

app.get("/missionscores/:missionId", (req, res) => {
	if (!missionTopScores || !missionReference) {
		res.status(500);
		res.json({error: "Please wait lmao"});
		return;
	}
	if (!("missionId" in req.params)) {
		res.status(400);
		res.json({error: "What player lmao"});
		return;
	}
	for (const [missionId, scores] of Object.entries(missionTopScores)) {
		if (missionId == req.params.missionId) {
			res.json({
				mission: missionReference[Number(missionId)],
				scores: scores,
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
