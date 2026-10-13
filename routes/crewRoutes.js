import express from 'express';
import { protectRouter } from '../middleware/auth.js';
import { createCrew, getUserCrews, getCrewMessages, sendCrewMessage } from '../controllers/crewController.js';

const crewRouter = express.Router();

crewRouter.post("/create", protectRouter, createCrew);
crewRouter.get("/", protectRouter, getUserCrews);
crewRouter.get("/:crewId/messages", protectRouter, getCrewMessages);
crewRouter.post("/:crewId/messages", protectRouter, sendCrewMessage);

export default crewRouter;
