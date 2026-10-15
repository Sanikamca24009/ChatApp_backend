import mongoose from "mongoose";
import Crew from "../models/Crew.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import cloundinary from "../lib/cloudinary.js";
import { io, userSocketMap, emitToUser } from "../server.js";

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
            isSystem: true,
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
            emitToUser(member._id, "newCrew", formatted);
            const socketSet = userSocketMap[member._id];
            if (socketSet) {
                socketSet.forEach(sockId => {
                    const sock = io.sockets.sockets.get(sockId);
                    if (sock) sock.join(`crew_${crew._id}`);
                });
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

        const unseenMessages = {};
        const lastMessages = {};

        const promises = crews.map(async (c) => {
            const unseenCount = await Message.countDocuments({
                crewId: c._id,
                seenBy: { $ne: userId },
                deletedFor: { $ne: userId },
                isDeletedForAll: { $ne: true }
            });
            unseenMessages[c._id.toString()] = unseenCount;

            const anyMsg = await Message.findOne({ crewId: c._id }).sort({ createdAt: -1 });

            if (anyMsg) {
                const lastVisibleMsg = await Message.findOne({
                    crewId: c._id,
                    deletedFor: { $ne: userId },
                    isDeletedForAll: { $ne: true }
                })
                .populate("senderId", "fullName")
                .sort({ createdAt: -1 });

                if (lastVisibleMsg) {
                    lastMessages[c._id.toString()] = {
                        _id: lastVisibleMsg._id.toString(),
                        crewId: c._id.toString(),
                        senderId: lastVisibleMsg.senderId?._id ? lastVisibleMsg.senderId._id.toString() : lastVisibleMsg.senderId?.toString(),
                        senderName: lastVisibleMsg.senderId?.fullName || "Crewmate",
                        text: lastVisibleMsg.text,
                        image: lastVisibleMsg.image,
                        editedAt: lastVisibleMsg.editedAt,
                        createdAt: lastVisibleMsg.createdAt,
                    };
                } else {
                    lastMessages[c._id.toString()] = {
                        _id: anyMsg._id.toString(),
                        crewId: c._id.toString(),
                        senderId: anyMsg.senderId?.toString(),
                        senderName: "Crewmate",
                        text: "🚫 Message deleted",
                        image: null,
                        createdAt: anyMsg.createdAt,
                    };
                }
            }
        });

        await Promise.all(promises);
        const formattedCrews = crews.map(c => formatCrewResponse(c));

        res.json({ success: true, crews: formattedCrews, unseenMessages, lastMessages });
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

        if (!crewId || !mongoose.Types.ObjectId.isValid(crewId)) {
            return res.status(400).json({ success: false, message: "Valid crew ID is required" });
        }

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

        const messages = await Message.find({
            crewId,
            deletedFor: { $ne: userId }
        })
        .populate("senderId", "fullName profilePic")
        .populate({
            path: "replyTo",
            select: "_id senderId text image createdAt isDeletedForAll",
            populate: { path: "senderId", select: "_id fullName" }
        })
        .populate("reactions.userId", "_id fullName profilePic")
        .sort({ createdAt: 1 });

        // Mark unseen messages as seen by this user
        await Message.updateMany(
            { crewId, seenBy: { $ne: userId }, deletedFor: { $ne: userId }, isDeletedForAll: { $ne: true } },
            { $addToSet: { seenBy: userId } }
        );

        // Real-time broadcast to crew room that this user has seen messages in this crew
        io.to(`crew_${crewId}`).emit("crewMessagesSeen", {
            crewId: crewId.toString(),
            userId: userId.toString()
        });

        const formattedMessages = messages.map(msg => {
            const isDeleted = Boolean(msg.isDeletedForAll);
            const isReplyDeleted = Boolean(msg.replyTo?.isDeletedForAll || msg.replyTo?.text === "This message was lost at sea");

            return {
                _id: msg._id.toString(),
                crewId: msg.crewId.toString(),
                senderId: msg.senderId ? (msg.senderId._id ? msg.senderId._id.toString() : msg.senderId.toString()) : null,
                senderName: msg.senderId?.fullName || "Crewmate",
                senderPic: msg.senderId?.profilePic || null,
                senderRole: msg.senderRole || (crew.captain.toString() === msg.senderId?._id?.toString() ? "Captain" : "Crewmate"),
                text: isDeleted ? "This message was lost at sea" : msg.text,
                image: isDeleted ? null : msg.image,
                isForwarded: Boolean(msg.isForwarded),
                isDeletedForAll: isDeleted,
                editedAt: msg.editedAt,
                reactions: msg.reactions || [],
                replyTo: msg.replyTo ? {
                    _id: msg.replyTo._id.toString(),
                    senderId: msg.replyTo.senderId ? (msg.replyTo.senderId._id ? msg.replyTo.senderId._id.toString() : msg.replyTo.senderId.toString()) : null,
                    senderName: msg.replyTo.senderId?.fullName || "Pirate",
                    text: isReplyDeleted ? "This message was lost at sea" : msg.replyTo.text,
                    image: isReplyDeleted ? null : msg.replyTo.image,
                    isDeletedForAll: isReplyDeleted,
                    createdAt: msg.replyTo.createdAt
                } : null,
                createdAt: msg.createdAt,
                status: msg.status || 'sent',
                seen: true,
                seenBy: (msg.seenBy || []).map(id => id.toString())
            };
        });

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
        const { text, image, replyTo } = req.body;
        const senderId = req.user._id;

        if (!crewId || !mongoose.Types.ObjectId.isValid(crewId)) {
            return res.status(400).json({ success: false, message: "Valid crew ID is required" });
        }

        const crew = await Crew.findById(crewId);
        if (!crew) {
            return res.json({ success: false, message: "Crew not found" });
        }

        const isCaptain = crew.captain.toString() === senderId.toString();
        const isMember = isCaptain || crew.members.some(m => m.user.toString() === senderId.toString());

        if (!isMember) {
            return res.json({ success: false, message: "You are not a member of this crew" });
        }

        // Validate replyTo: must exist and belong to this same crewId
        let validReplyToId = null;
        let populatedReplyTo = null;
        if (replyTo) {
            const replyMsg = await Message.findOne({
                _id: replyTo,
                crewId
            }).populate("senderId", "_id fullName");

            if (replyMsg) {
                validReplyToId = replyMsg._id;
                populatedReplyTo = {
                    _id: replyMsg._id.toString(),
                    senderId: replyMsg.senderId ? (replyMsg.senderId._id ? replyMsg.senderId._id.toString() : replyMsg.senderId.toString()) : null,
                    senderName: replyMsg.senderId?.fullName || "Pirate",
                    text: replyMsg.text,
                    image: replyMsg.image,
                    createdAt: replyMsg.createdAt
                };
            }
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
            replyTo: validReplyToId,
            status: "sent",
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
            isForwarded: false,
            replyTo: populatedReplyTo,
            createdAt: newMessage.createdAt,
            status: "sent",
            seen: false,
            seenBy: [senderId.toString()]
        };

        // Broadcast to crew room
        io.to(`crew_${crewId}`).emit("newCrewMessage", formattedMsg);

        // Also ensure online members who haven't joined room receive it
        crew.members.forEach(member => {
            const mId = member.user.toString();
            emitToUser(mId, "newCrewMessage", formattedMsg);
        });

        res.json({ success: true, newMessage: formattedMsg });
    } catch (error) {
        console.error("sendCrewMessage error:", error);
        res.json({ success: false, message: error.message });
    }
};
