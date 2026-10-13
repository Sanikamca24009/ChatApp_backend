import express from 'express'
import "dotenv/config"
import cors from "cors"
import http from "http"
import { connectDB } from './lib/db.js'
import userRouter from './routes/userRoutes.js'
import messageRouter from './routes/messageRoutes.js'
import crewRouter from './routes/crewRoutes.js'
import { Server } from 'socket.io'

//Create express app and HTTP server 
const app = express()
const server = http.createServer(app)

// Initialize the socket.io server 
export const io = new Server(server, {
    cors: { origin: "*"}
})

//store the online users 
export const userSocketMap = {}; //{ userId : socketId}

// Socket.io connection handler 
io.on("connection", (socket)=>{
    const userId = socket.handshake.query.userId;
    console.log("User Connected", userId)

    if(userId) userSocketMap[userId] = socket.id;

    //Emit online users to all connected clients
    io.emit("getOnlineUsers", Object.keys(userSocketMap));

    // Handle joining and leaving crew rooms
    socket.on("joinCrew", (crewId) => {
        if (crewId) socket.join(`crew_${crewId}`);
    });

    socket.on("leaveCrew", (crewId) => {
        if (crewId) socket.leave(`crew_${crewId}`);
    });

    // ── Call Signaling Events (Audio & Video) ──
    socket.on("callUser", ({ recipientId, caller, callType }) => {
        const recipientSocketId = userSocketMap[recipientId];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit("incomingCall", {
                caller,
                callType: callType || 'audio',
                timestamp: Date.now()
            });
        } else {
            socket.emit("callUnavailable", { message: "User is currently offline across the Grand Line" });
        }
    });

    socket.on("acceptCall", ({ callerId, recipient, callType }) => {
        const callerSocketId = userSocketMap[callerId];
        if (callerSocketId) {
            io.to(callerSocketId).emit("callAccepted", { recipient, callType });
        }
    });

    socket.on("rejectCall", ({ callerId }) => {
        const callerSocketId = userSocketMap[callerId];
        if (callerSocketId) {
            io.to(callerSocketId).emit("callRejected");
        }
    });

    socket.on("endCall", ({ targetUserId }) => {
        const targetSocketId = userSocketMap[targetUserId];
        if (targetSocketId) {
            io.to(targetSocketId).emit("callEnded");
        }
    });

    socket.on("webrtcSignal", ({ targetUserId, signal }) => {
        const targetSocketId = userSocketMap[targetUserId];
        if (targetSocketId) {
            io.to(targetSocketId).emit("webrtcSignal", { signal, senderId: userId });
        }
    });

    socket.on("disconnect", ()=>{
        console.log("User Disconnected ", userId)
        delete userSocketMap[userId];
        io.emit("getOnlineUsers", Object.keys(userSocketMap))
    })
})


//Middle ware setup
app.use(express.json({limit: "4mb"}))
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
