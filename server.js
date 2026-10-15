import express from 'express'
import "dotenv/config"
import cors from "cors"
import http from "http"
import { connectDB } from './lib/db.js'
import userRouter from './routes/userRoutes.js'
import messageRouter from './routes/messageRoutes.js'
import crewRouter from './routes/crewRoutes.js'
import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import Crew from './models/Crew.js'
import User from './models/User.js'
import Message from './models/Message.js'

//Create express app and HTTP server 
const app = express()
const server = http.createServer(app)

// Initialize the socket.io server 
export const io = new Server(server, {
    cors: { origin: "*"}
})

// Socket.io JWT Authentication Middleware
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.token;
        if (!token) {
            return next(new Error("Authentication error: No token provided"));
        }
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded || !decoded.userId) {
            return next(new Error("Authentication error: Invalid token"));
        }
        socket.userId = decoded.userId.toString();
        next();
    } catch (err) {
        return next(new Error("Authentication error: " + err.message));
    }
});

// Store the online users: { [userId]: Set<socketId> } for multi-tab support
export const userSocketMap = {};

// Helper to emit an event to all active sockets of a user
export const emitToUser = (userId, event, data) => {
    if (!userId) return;
    const socketSet = userSocketMap[userId.toString()];
    if (socketSet && socketSet.size > 0) {
        socketSet.forEach((sockId) => {
            io.to(sockId).emit(event, data);
        });
    }
};

// Helper to check if a user is currently online
export const isUserOnline = (userId) => {
    if (!userId) return false;
    const socketSet = userSocketMap[userId.toString()];
    return Boolean(socketSet && socketSet.size > 0);
};

// Socket.io connection handler 
io.on("connection", async (socket)=>{
    const userId = socket.userId;
    console.log("User Connected", userId, "socket:", socket.id);

    if (!userSocketMap[userId]) {
        userSocketMap[userId] = new Set();
    }
    userSocketMap[userId].add(socket.id);

    // Emit online users to all connected clients
    io.emit("getOnlineUsers", Object.keys(userSocketMap));

    // Automatically join the user to all crew rooms they belong to on connection/reconnect
    try {
        const userCrews = await Crew.find({
            $or: [
                { captain: userId },
                { "members.user": userId }
            ]
        }).select("_id");

        userCrews.forEach((crew) => {
            socket.join(`crew_${crew._id}`);
        });
    } catch (err) {
        console.error("Error auto-joining crew rooms for user", userId, err.message);
    }

    // Auto-deliver all pending messages sent to this user while offline
    try {
        const pendingMessages = await Message.find({
            receiverId: userId,
            status: "sent"
        }).select("_id senderId");

        if (pendingMessages.length > 0) {
            await Message.updateMany(
                { receiverId: userId, status: "sent" },
                { status: "delivered" }
            );

            // Group message IDs by sender to batch notifications
            const batchBySender = {};
            pendingMessages.forEach((msg) => {
                const sId = msg.senderId.toString();
                if (!batchBySender[sId]) batchBySender[sId] = [];
                batchBySender[sId].push(msg._id.toString());
            });

            // Emit to each affected sender
            Object.entries(batchBySender).forEach(([senderId, messageIds]) => {
                emitToUser(senderId, "messagesDelivered", { messageIds, status: "delivered" });
                messageIds.forEach((id) => {
                    emitToUser(senderId, "messageDelivered", { messageId: id, status: "delivered" });
                });
            });
        }
    } catch (err) {
        console.error("Error auto-delivering pending messages for user", userId, err.message);
    }

    // Handle joining and leaving crew rooms
    socket.on("joinCrew", (crewId) => {
        if (crewId) socket.join(`crew_${crewId}`);
    });

    socket.on("leaveCrew", (crewId) => {
        if (crewId) socket.leave(`crew_${crewId}`);
    });

    // ── Real Message Status Acknowledgment: Delivered ──
    socket.on("ackDelivered", async ({ messageId, senderId }) => {
        if (!messageId) return;
        try {
            const msg = await Message.findById(messageId);
            if (!msg) return;

            // Verify that authenticated socket.userId is the receiver (or crew member)
            const isAuthorizedReceiver = msg.crewId
                ? (await Crew.exists({ _id: msg.crewId, $or: [{ captain: userId }, { "members.user": userId }] }))
                : (msg.receiverId && msg.receiverId.toString() === userId.toString());

            if (!isAuthorizedReceiver) {
                console.warn(`[Security] Unauthorized ackDelivered attempt by user ${userId} for message ${messageId}`);
                return;
            }

            if (msg.status === "sent") {
                msg.status = "delivered";
                await msg.save();
                emitToUser(senderId || msg.senderId, "messageDelivered", {
                    messageId: msg._id.toString(),
                    status: "delivered"
                });
            }
        } catch (err) {
            console.error("Error handling ackDelivered:", err.message);
        }
    });

    // ── Real Message Status Acknowledgment: Seen ──
    socket.on("ackSeen", async ({ messageId, senderId }) => {
        if (!messageId) return;
        try {
            const msg = await Message.findById(messageId);
            if (!msg) return;

            // Verify that authenticated socket.userId is the receiver (or crew member)
            const isAuthorizedReceiver = msg.crewId
                ? (await Crew.exists({ _id: msg.crewId, $or: [{ captain: userId }, { "members.user": userId }] }))
                : (msg.receiverId && msg.receiverId.toString() === userId.toString());

            if (!isAuthorizedReceiver) {
                console.warn(`[Security] Unauthorized ackSeen attempt by user ${userId} for message ${messageId}`);
                return;
            }

            if (msg.status !== "seen") {
                msg.status = "seen";
                msg.seen = true;
                if (msg.crewId && !msg.seenBy?.some(id => id.toString() === userId.toString())) {
                    msg.seenBy.push(userId);
                }
                await msg.save();
                emitToUser(senderId || msg.senderId, "messageSeen", {
                    messageId: msg._id.toString(),
                    status: "seen"
                });
            }
        } catch (err) {
            console.error("Error handling ackSeen:", err.message);
        }
    });

    // ── Call Signaling Events (Audio & Video) ──
    socket.on("callUser", ({ recipientId, caller, callType }) => {
        if (isUserOnline(recipientId)) {
            emitToUser(recipientId, "incomingCall", {
                caller,
                callType: callType || 'audio',
                timestamp: Date.now()
            });
        } else {
            socket.emit("callUnavailable", { message: "User is currently offline across the Grand Line" });
        }
    });

    socket.on("acceptCall", ({ callerId, recipient, callType }) => {
        emitToUser(callerId, "callAccepted", { recipient, callType });
    });

    socket.on("rejectCall", ({ callerId }) => {
        emitToUser(callerId, "callRejected");
    });

    socket.on("endCall", ({ targetUserId }) => {
        emitToUser(targetUserId, "callEnded");
    });

    socket.on("webrtcSignal", ({ targetUserId, signal }) => {
        emitToUser(targetUserId, "webrtcSignal", { signal, senderId: userId });
    });

    // ── Typing Indicator Events ──
    socket.on("typing:start", async ({ recipientId, crewId }) => {
        try {
            if (recipientId) {
                // Verify mutual follow between authenticated socket.userId and recipientId
                const isMutual = await User.exists({
                    _id: userId,
                    following: recipientId,
                    followers: recipientId
                });
                if (!isMutual) return;

                const sender = await User.findById(userId, "fullName");
                if (!sender) return;

                socket.typingTarget = { recipientId };
                emitToUser(recipientId, "userTyping:start", {
                    senderId: userId.toString(),
                    senderName: sender.fullName
                });
            } else if (crewId) {
                // Verify crew membership
                const isMember = await Crew.exists({
                    _id: crewId,
                    $or: [{ captain: userId }, { "members.user": userId }]
                });
                if (!isMember) return;

                const sender = await User.findById(userId, "fullName");
                if (!sender) return;

                socket.typingTarget = { crewId };
                socket.to(`crew_${crewId}`).emit("userTyping:start", {
                    crewId: crewId.toString(),
                    senderId: userId.toString(),
                    senderName: sender.fullName
                });
            }
        } catch (err) {
            console.error("Error in typing:start:", err.message);
        }
    });

    socket.on("typing:stop", ({ recipientId, crewId }) => {
        try {
            socket.typingTarget = null;
            if (recipientId) {
                emitToUser(recipientId, "userTyping:stop", {
                    senderId: userId.toString()
                });
            } else if (crewId) {
                socket.to(`crew_${crewId}`).emit("userTyping:stop", {
                    crewId: crewId.toString(),
                    senderId: userId.toString()
                });
            }
        } catch (err) {
            console.error("Error in typing:stop:", err.message);
        }
    });

    socket.on("disconnect", async ()=>{
        console.log("User Socket Disconnected ", userId, socket.id);

        // Clear active typing indicator if user disconnects while typing
        if (socket.typingTarget) {
            const { recipientId, crewId } = socket.typingTarget;
            if (recipientId) {
                emitToUser(recipientId, "userTyping:stop", {
                    senderId: userId.toString()
                });
            } else if (crewId) {
                socket.to(`crew_${crewId}`).emit("userTyping:stop", {
                    crewId: crewId.toString(),
                    senderId: userId.toString()
                });
            }
            socket.typingTarget = null;
        }

        if (userSocketMap[userId]) {
            userSocketMap[userId].delete(socket.id);
            // Only update lastSeen when the last socket/tab of that user closes
            if (userSocketMap[userId].size === 0) {
                delete userSocketMap[userId];
                const lastSeen = new Date();
                try {
                    await User.findByIdAndUpdate(userId, { lastSeen });
                } catch (e) {
                    console.error("Error saving lastSeen:", e.message);
                }
                io.emit("userLastSeen", { userId, lastSeen });
                io.emit("getOnlineUsers", Object.keys(userSocketMap));
            }
        }
    });
})


// Middleware setup (15mb to safely support base64-encoded high-res image uploads with Cloudinary)
app.use(express.json({ limit: "15mb" }))
app.use(express.urlencoded({ limit: "15mb", extended: true }))
app.use(cors())

//routes setup
app.use('/api/status', (req,res) => res.send("Server is live"))
app.use('/api/auth', userRouter)
app.use('/api/messages', messageRouter)
app.use('/api/crews', crewRouter)

//connect to mongodb
await connectDB();

if(process.env.NODE_ENV !== "production" || !process.env.VERCEL){
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, ()=> console.log("Server is running on PORT: "+ PORT))
}

// Export server for vercel
export default server;
