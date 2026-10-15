import express from 'express'
import { protectRouter } from '../middleware/auth.js';
import { editMessage, deleteMessage, forwardMessage, getMessages, getUserForSidebar, markMessageAsSeen, reactToMessage, sendMessage } from '../controllers/messageController.js';

const messageRouter = express.Router();


messageRouter.get("/users", protectRouter, getUserForSidebar);
messageRouter.post("/forward", protectRouter, forwardMessage);
messageRouter.put("/edit/:id", protectRouter, editMessage);
messageRouter.post("/delete/:id", protectRouter, deleteMessage);
messageRouter.post("/react/:id", protectRouter, reactToMessage);
messageRouter.get("/:id", protectRouter, getMessages)
messageRouter.put("/mark/:id", protectRouter, markMessageAsSeen)
messageRouter.post("/send/:id",protectRouter, sendMessage)

export default messageRouter;