import Crew from "../models/Crew.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import cloundinary from "../lib/cloudinary.js";
import { io, userSocketMap } from "../server.js";

// Helper to format crew object for frontend compatibility
export const formatCrewResponse = (crew) => {
    const rawCrew = crew.toObject ? crew.toObject() : crew;
    return {
        _id: rawCrew._id.toString(),
        name: rawCrew.name,
        fullName: rawCrew.name, // matched frontend expectations
        flag: rawCrew.flag || '🏴‍☠️',
        emblem: rawCrew.flag || '🏴‍☠️',
        captain: rawCrew.captain ? {
            _id: rawCrew.captain._id ? rawCrew.captain._id.toString() : rawCrew.captain.toString(),
            fullName: rawCrew.captain.fullName || 'Captain',
            profilePic: rawCrew.captain.profilePic || null,
            bio: rawCrew.captain.bio || ''
        } : null,
        members: (rawCrew.members || []).map(m => {
            const u = m.user || {};
            return {
                _id: u._id ? u._id.toString() : (m.user ? m.user.toString() : ''),
                fullName: u.fullName || 'Crewmate',
                profilePic: u.profilePic || null,
                bio: u.bio || '',
                role: m.role || 'Crewmate'
            };
        }),
        isGroup: true,
        isCrew: true,
        createdAt: rawCrew.createdAt,
        updatedAt: rawCrew.updatedAt,
    };
};

// Assemble / Create a new Crew
export const createCrew = async (req, res) => {
    try {
        const { name, flag, members } = req.body;
        const captainId = req.user._id;

        if (!name || !name.trim()) {
            return res.json({ success: false, message: "Crew name is required" });
        }

        // Build member list, ensuring captain is included
        const memberUserIds = Array.isArray(members) ? members : [];
        const uniqueMemberIds = Array.from(new Set([captainId.toString(), ...memberUserIds.map(id => id.toString())]));

        const membersArray = uniqueMemberIds.map(uid => ({
            user: uid,
            role: uid === captainId.toString() ? "Captain" : "Crewmate"
        }));

        const crew = await Crew.create({
            name: name.trim(),
            flag: flag || '🏴‍☠️',
            captain: captainId,
            members: membersArray
        });

        // Populate captain & member users
        const populatedCrew = await Crew.findById(crew._id)
            .populate("captain", "fullName profilePic bio")
            .populate("members.user", "fullName profilePic bio");

        const formatted = formatCrewResponse(populatedCrew);

        // Inaugural welcome message
        const captainName = req.user.fullName || "Captain";
        const otherMembersNames = formatted.members
            .filter(m => m._id !== captainId.toString())
            .map(m => m.fullName);
        const welcomeRoster = otherMembersNames.length > 0 ? otherMembersNames.join(", ") : "all pirates";
        const inauguralText = `${formatted.flag} Crew "${formatted.name}" assembled! 👑 Captain ${captainName} welcomes ${welcomeRoster} aboard! Let's set sail! ⛵`;

        const inauguralMsg = await Message.create({
            senderId: captainId,
            crewId: crew._id,
            senderRole: "Captain",
            text: inauguralText,
            seen: true,
            seenBy: [captainId]
        });

        const formattedMsg = {
            _id: inauguralMsg._id.toString(),
            crewId: crew._id.toString(),
            senderId: captainId.toString(),
            senderName: captainName,
            senderPic: req.user.profilePic || null,
            senderRole: "Captain",
            text: inauguralText,
            createdAt: inauguralMsg.createdAt,
            seen: true
        };

        // Notify all online crew members via Socket.IO
        formatted.members.forEach(member => {
            const socketId = userSocketMap[member._id];
            if (socketId) {
                const sock = io.sockets.sockets.get(socketId);
                if (sock) {
                    sock.join(`crew_${crew._id}`);
                }
                io.to(socketId).emit("newCrew", formatted);
            }
        });

        // Emit inaugural message to room
        io.to(`crew_${crew._id}`).emit("newCrewMessage", formattedMsg);

        res.json({ success: true, crew: formatted, inauguralMsg: formattedMsg });
    } catch (error) {
        console.error("createCrew error:", error);
        res.json({ success: false, message: error.message });
    }
};

// Get all crews the current user belongs to
export const getUserCrews = async (req, res) => {
    try {
        const userId = req.user._id;
        const crews = await Crew.find({
            $or: [
                { captain: userId },
                { "members.user": userId }
            ]
        })
        .populate("captain", "fullName profilePic bio")
        .populate("members.user", "fullName profilePic bio")
        .sort({ updatedAt: -1 });

        const formattedCrews = crews.map(c => formatCrewResponse(c));

        res.json({ success: true, crews: formattedCrews });
    } catch (error) {
        console.error("getUserCrews error:", error);
        res.json({ success: false, message: error.message });
    }
};

// Get messages for a specific crew
export const getCrewMessages = async (req, res) => {
    try {
        const { crewId } = req.params;
        const userId = req.user._id;

        // Verify user is in crew
        const crew = await Crew.findById(crewId);
        if (!crew) {
            return res.json({ success: false, message: "Crew not found" });
        }

        const isMember = crew.captain.toString() === userId.toString() ||
            crew.members.some(m => m.user.toString() === userId.toString());

        if (!isMember) {
            return res.json({ success: false, message: "You are not a member of this crew" });
        }

        const messages = await Message.find({ crewId })
            .populate("senderId", "fullName profilePic")
            .sort({ createdAt: 1 });

        // Mark unseen messages as seen by this user
        await Message.updateMany(
            { crewId, seenBy: { $ne: userId } },
            { $addToSet: { seenBy: userId } }
        );

        const formattedMessages = messages.map(msg => ({
            _id: msg._id.toString(),
            crewId: msg.crewId.toString(),
            senderId: msg.senderId ? (msg.senderId._id ? msg.senderId._id.toString() : msg.senderId.toString()) : null,
            senderName: msg.senderId?.fullName || "Crewmate",
            senderPic: msg.senderId?.profilePic || null,
            senderRole: msg.senderRole || (crew.captain.toString() === msg.senderId?._id?.toString() ? "Captain" : "Crewmate"),
            text: msg.text,
            image: msg.image,
            createdAt: msg.createdAt,
            seen: true
        }));

        res.json({ success: true, messages: formattedMessages });
    } catch (error) {
        console.error("getCrewMessages error:", error);
        res.json({ success: false, message: error.message });
    }
};

// Send message to crew
export const sendCrewMessage = async (req, res) => {
    try {
        const { crewId } = req.params;
        const { text, image } = req.body;
        const senderId = req.user._id;

        const crew = await Crew.findById(crewId);
        if (!crew) {
            return res.json({ success: false, message: "Crew not found" });
        }

        const isCaptain = crew.captain.toString() === senderId.toString();
        const isMember = isCaptain || crew.members.some(m => m.user.toString() === senderId.toString());

        if (!isMember) {
            return res.json({ success: false, message: "You are not a member of this crew" });
        }

        let imageUrl;
        if (image) {
            const uploadResponse = await cloundinary.uploader.upload(image);
            imageUrl = uploadResponse.secure_url;
        }

        const senderRole = isCaptain ? "Captain" : "Crewmate";

        const newMessage = await Message.create({
            senderId,
            crewId,
            senderRole,
            text,
            image: imageUrl,
            seenBy: [senderId]
        });

        // Touch crew updatedAt
        await Crew.findByIdAndUpdate(crewId, { updatedAt: new Date() });

        const formattedMsg = {
            _id: newMessage._id.toString(),
            crewId: crewId.toString(),
            senderId: senderId.toString(),
            senderName: req.user.fullName || "Pirate",
            senderPic: req.user.profilePic || null,
            senderRole,
            text,
            image: imageUrl,
            createdAt: newMessage.createdAt,
            seen: true
        };

        // Broadcast to crew room
        io.to(`crew_${crewId}`).emit("newCrewMessage", formattedMsg);

        // Also ensure online members who haven't joined room receive it
        crew.members.forEach(member => {
            const mId = member.user.toString();
            const socketId = userSocketMap[mId];
            if (socketId) {
                io.to(socketId).emit("newCrewMessage", formattedMsg);
            }
        });

        res.json({ success: true, newMessage: formattedMsg });
    } catch (error) {
        console.error("sendCrewMessage error:", error);
        res.json({ success: false, message: error.message });
    }
};
