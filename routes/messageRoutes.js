import express from 'express'
import { protectRouter } from '../middleware/auth.js';
import { getMessages, getUserForSidebar, markMessageAsSeen, sendMessage } from '../controllers/messageController.js';

const messageRouter = express.Router();


messageRouter.get("/users", protectRouter, getUserForSidebar);
messageRouter.get("/:id", protectRouter, getMessages)
messageRouter.put("/mark/:id", protectRouter, markMessageAsSeen)
messageRouter.post("/send/:id",protectRouter, sendMessage)

export default messageRouter;