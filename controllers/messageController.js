import mongoose from "mongoose";
import Message from "../models/Message.js";
import User from "../models/User.js";
import Crew from "../models/Crew.js";
import cloundinary from "../lib/cloudinary.js";
import { io, userSocketMap, emitToUser, isUserOnline } from "../server.js";

// get users who are mutual followers (both have followed each other)
export const getUserForSidebar = async (req, res)=>{
    try {
        const userId = req.user._id.toString();
        const currentUser = await User.findById(userId);
        if (!currentUser) {
            return res.json({ success: false, message: "User not found" });
        }

        const myFollowing = (currentUser.following || []).map(id => id.toString());
        const myFollowers = (currentUser.followers || []).map(id => id.toString());

        // Find users that are mutual follows (both follow each other)
        const mutualUserIds = myFollowing.filter(id => myFollowers.includes(id));

        const mutualUsers = await User.find({ _id: { $in: mutualUserIds } }).select("-password");

        // count number of messages not seen & fetch last message
        const unseenMessages = {};
        const lastMessages = {};

        const promises = mutualUsers.map(async (user)=>{
            const unseenCount = await Message.countDocuments({
                senderId: user._id,
                receiverId: userId,
                seen: false,
                deletedFor: { $ne: userId },
                isDeletedForAll: { $ne: true }
            });
            unseenMessages[user._id.toString()] = unseenCount;

            const anyMsg = await Message.findOne({
                $or: [
                    { senderId: userId, receiverId: user._id },
                    { senderId: user._id, receiverId: userId }
                ]
            }).sort({ createdAt: -1 });

            if (anyMsg) {
                const lastVisibleMsg = await Message.findOne({
                    $or: [
                        { senderId: userId, receiverId: user._id },
                        { senderId: user._id, receiverId: userId }
                    ],
                    deletedFor: { $ne: userId },
                    isDeletedForAll: { $ne: true }
                }).sort({ createdAt: -1 });

                if (lastVisibleMsg) {
                    lastMessages[user._id.toString()] = {
                        _id: lastVisibleMsg._id.toString(),
                        senderId: lastVisibleMsg.senderId.toString(),
                        receiverId: lastVisibleMsg.receiverId ? lastVisibleMsg.receiverId.toString() : null,
                        text: lastVisibleMsg.text,
                        image: lastVisibleMsg.image,
                        status: lastVisibleMsg.status || (lastVisibleMsg.seen ? 'seen' : 'sent'),
                        editedAt: lastVisibleMsg.editedAt,
                        createdAt: lastVisibleMsg.createdAt,
                    };
                } else {
                    lastMessages[user._id.toString()] = {
                        _id: anyMsg._id.toString(),
                        senderId: anyMsg.senderId.toString(),
                        receiverId: anyMsg.receiverId ? anyMsg.receiverId.toString() : null,
                        text: "🚫 Message deleted",
                        image: null,
                        status: anyMsg.status || (anyMsg.seen ? 'seen' : 'sent'),
                        createdAt: anyMsg.createdAt,
                    };
                }
            }
        });

        await Promise.all(promises);
        res.json({ success: true, users: mutualUsers, unseenMessages, lastMessages });

    } catch (error) {
        console.log(error.message)
        res.json({success: false, message: error.message})
    }
}

// Get all message for selected users
export const getMessages = async (req, res) =>{
    try {
        const {id : selectedUserId } = req.params;
        const myId = req.user._id;

        if (!selectedUserId || !mongoose.Types.ObjectId.isValid(selectedUserId)) {
            return res.status(400).json({ success: false, message: "Valid user ID is required" });
        }

        const messages = await Message.find({
            $or:  [
                {senderId: myId, receiverId: selectedUserId},
                {senderId: selectedUserId, receiverId: myId},
            ],
            deletedFor: { $ne: myId }
        })
        .populate({
            path: "replyTo",
            select: "_id senderId text image createdAt isDeletedForAll",
            populate: { path: "senderId", select: "_id fullName" }
        })
        .populate("reactions.userId", "_id fullName profilePic")
        .sort({ createdAt: 1 });

        const formattedMessages = messages.map(msg => {
            const m = msg.toObject();
            if (m.isDeletedForAll) {
                m.text = "This message was lost at sea";
                m.image = null;
            }
            if (m.replyTo) {
                const isQuoteDeleted = Boolean(m.replyTo.isDeletedForAll || m.replyTo.text === "This message was lost at sea");
                m.replyTo = {
                    _id: m.replyTo._id.toString(),
                    senderId: m.replyTo.senderId ? (m.replyTo.senderId._id ? m.replyTo.senderId._id.toString() : m.replyTo.senderId.toString()) : null,
                    senderName: m.replyTo.senderId?.fullName || "Pirate",
                    text: isQuoteDeleted ? "This message was lost at sea" : m.replyTo.text,
                    image: isQuoteDeleted ? null : m.replyTo.image,
                    isDeletedForAll: isQuoteDeleted,
                    createdAt: m.replyTo.createdAt
                };
            }
            return m;
        });

        // Update all incoming unread messages from selectedUserId as seen
        await Message.updateMany(
            { senderId: selectedUserId, receiverId: myId, status: { $ne: "seen" }, deletedFor: { $ne: myId }, isDeletedForAll: { $ne: true } },
            { status: "seen", seen: true }
        );

        // Real-time emit to sender that their messages have been seen!
        emitToUser(selectedUserId, "messagesSeen", { byUserId: myId.toString() });

        res.json({success: true, messages: formattedMessages})
    } catch (error) {
        console.log(error.message)
        res.json({success: false, message: error.message})
    }
}

// api to mark message as seen using message id
export const markMessageAsSeen = async (req, res) =>{
    try {
        const { id } = req.params;
        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Valid message ID is required" });
        }
        const updated = await Message.findByIdAndUpdate(id, { status: "seen", seen: true }, { new: true });
        if (updated) {
            emitToUser(updated.senderId, "messageSeen", {
                messageId: updated._id.toString(),
                status: "seen",
                byUserId: req.user._id.toString()
            });
        }
        res.json({success: true})

    } catch (error) {
        console.log(error.message)
        res.json({success: false, message: error.message})
    }
}

// Send message to selected user 
export const sendMessage = async (req, res)=>{
try {
    const {image, text, replyTo } = req.body;
    const receiverId = req.params.id;
    const senderId = req.user._id;

    if (!receiverId || !mongoose.Types.ObjectId.isValid(receiverId)) {
        return res.status(400).json({ success: false, message: "Valid receiver ID is required" });
    }

    // Validate replyTo: must exist and belong to this same 1-to-1 conversation pair
    let validReplyToId = null;
    let populatedReplyTo = null;
    if (replyTo) {
        const replyMsg = await Message.findOne({
            _id: replyTo,
            $or: [
                { senderId, receiverId },
                { senderId: receiverId, receiverId: senderId }
            ]
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
    if(image){
        const uploadResponse = await cloundinary.uploader.upload(image)
        imageUrl = uploadResponse.secure_url;
    }

    const newMessage = await Message.create({
        senderId,
        receiverId,
        text,
        image: imageUrl,
        replyTo: validReplyToId,
        status: "sent",
        seen: false
    });

    const formattedNewMessage = {
        ...newMessage.toObject(),
        replyTo: populatedReplyTo
    };

    // Emit the new message to the receiver's active sockets if online
    if (isUserOnline(receiverId)) {
        emitToUser(receiverId, "newMessage", formattedNewMessage);
    }

    res.json({success: true, newMessage: formattedNewMessage});
      
} catch (error) {
    console.log(error.message)
    res.json({success: false, message: error.message})
}
}

// Forward message to up to 5 targets (direct pirates or crews)
export const forwardMessage = async (req, res) => {
    try {
        const { sourceMessageId, targets } = req.body;
        const myId = req.user._id;

        // 1. Validate sourceMessageId
        if (!sourceMessageId || !mongoose.Types.ObjectId.isValid(sourceMessageId)) {
            return res.status(400).json({ success: false, message: "Valid sourceMessageId is required" });
        }

        // 2. Validate targets payload: must be array of at most 5 {id, type} items with valid ObjectId and type in ["user", "crew"]
        if (!Array.isArray(targets) || targets.length === 0 || targets.length > 5) {
            return res.status(400).json({
                success: false,
                message: "Targets must be an array of 1 to 5 items"
            });
        }

        for (const t of targets) {
            if (!t || typeof t !== 'object' || Array.isArray(t)) {
                return res.status(400).json({
                    success: false,
                    message: "Each target must be an object with 'id' and 'type'"
                });
            }
            if (!t.id || !mongoose.Types.ObjectId.isValid(t.id)) {
                return res.status(400).json({
                    success: false,
                    message: "Each target must have a valid ObjectId 'id'"
                });
            }
            if (!['user', 'crew'].includes(t.type)) {
                return res.status(400).json({
                    success: false,
                    message: "Each target 'type' must be either 'user' or 'crew'"
                });
            }
        }

        // 3. Deduplicate targets
        const uniqueTargets = [];
        const seenTargetIds = new Set();
        for (const t of targets) {
            const idStr = t.id.toString();
            if (!seenTargetIds.has(idStr)) {
                seenTargetIds.add(idStr);
                uniqueTargets.push({ id: idStr, type: t.type });
            }
        }

        // 4. Validate access to source message: authenticated user must be sender/receiver or crew member
        const sourceMsg = await Message.findById(sourceMessageId);
        if (!sourceMsg) {
            return res.status(404).json({ success: false, message: "Source message not found" });
        }

        let hasSourceAccess = false;
        if (sourceMsg.crewId) {
            const isCrewMember = await Crew.exists({
                _id: sourceMsg.crewId,
                $or: [
                    { captain: myId },
                    { "members.user": myId }
                ]
            });
            hasSourceAccess = Boolean(isCrewMember);
        } else {
            const isSender = sourceMsg.senderId?.toString() === myId.toString();
            const isReceiver = sourceMsg.receiverId?.toString() === myId.toString();
            hasSourceAccess = isSender || isReceiver;
        }

        if (!hasSourceAccess) {
            return res.status(403).json({
                success: false,
                message: "Forbidden: You are not allowed to access this message"
            });
        }

        // 5. Reject server-side forwarding of crew system/inaugural messages (and any future system message type)
        const isSystemMessage = Boolean(
            sourceMsg.isSystem ||
            sourceMsg.senderRole === "System" ||
            (sourceMsg.crewId && sourceMsg.text && (
                sourceMsg.text.includes("assembled!") && sourceMsg.text.includes("Let's set sail!")
            ))
        );

        if (isSystemMessage) {
            return res.status(400).json({
                success: false,
                message: "System messages cannot be forwarded"
            });
        }

        // 6. Preload user's mutual follows and crew memberships with roles
        const currentUser = await User.findById(myId).select("following followers");
        const myFollowing = (currentUser?.following || []).map(id => id.toString());
        const myFollowers = (currentUser?.followers || []).map(id => id.toString());
        const mutualFollowSet = new Set(myFollowing.filter(id => myFollowers.includes(id)));

        const myCrews = await Crew.find({
            $or: [
                { captain: myId },
                { "members.user": myId }
            ]
        });
        const crewMap = new Map();
        myCrews.forEach(c => {
            const isCaptain = c.captain.toString() === myId.toString();
            const memberEntry = (c.members || []).find(m => m.user?.toString() === myId.toString());
            const role = isCaptain ? "Captain" : (memberEntry?.role || "Crewmate");
            crewMap.set(c._id.toString(), {
                crew: c,
                role
            });
        });

        const successfulTargets = [];
        const skippedTargets = [];
        const createdMessages = [];

        // 5. Forward to each target
        for (const target of uniqueTargets) {
            if (target.type === 'user') {
                // (b) Mutual follow check
                if (!mutualFollowSet.has(target.id) || target.id === myId.toString()) {
                    skippedTargets.push({ id: target.id, type: 'user', reason: "Not a mutual follower" });
                    continue;
                }

                // Create new forwarded message for direct chat (status starts as sent, no replyTo, seen: false)
                const newMsg = await Message.create({
                    senderId: myId,
                    receiverId: target.id,
                    text: sourceMsg.text || "",
                    image: sourceMsg.image || null,
                    isForwarded: true,
                    status: "sent",
                    seen: false,
                    replyTo: null
                });

                const formattedNewMsg = {
                    ...newMsg.toObject(),
                    replyTo: null
                };

                // Emit newMessage event to receiver if online
                if (isUserOnline(target.id)) {
                    emitToUser(target.id, "newMessage", formattedNewMsg);
                }

                successfulTargets.push({ id: target.id, type: 'user', messageId: newMsg._id.toString() });
                createdMessages.push(formattedNewMsg);

            } else if (target.type === 'crew') {
                // (c) Crew membership check
                if (!crewMap.has(target.id)) {
                    skippedTargets.push({ id: target.id, type: 'crew', reason: "Not a member of this crew" });
                    continue;
                }

                const crewInfo = crewMap.get(target.id);
                const senderRole = crewInfo.role;

                // Create new forwarded message for crew
                const newMsg = await Message.create({
                    senderId: myId,
                    crewId: target.id,
                    senderRole,
                    text: sourceMsg.text || "",
                    image: sourceMsg.image || null,
                    isForwarded: true,
                    status: "sent",
                    seen: false,
                    seenBy: [myId],
                    replyTo: null
                });

                // Update crew updatedAt
                await Crew.findByIdAndUpdate(target.id, { updatedAt: new Date() });

                const formattedCrewMsg = {
                    _id: newMsg._id.toString(),
                    crewId: target.id.toString(),
                    senderId: myId.toString(),
                    senderName: req.user.fullName || "Pirate",
                    senderPic: req.user.profilePic || null,
                    senderRole,
                    text: sourceMsg.text || "",
                    image: sourceMsg.image || null,
                    isForwarded: true,
                    replyTo: null,
                    createdAt: newMsg.createdAt,
                    status: "sent",
                    seen: false,
                    seenBy: [myId.toString()]
                };

                // Broadcast newCrewMessage to crew room
                io.to(`crew_${target.id}`).emit("newCrewMessage", formattedCrewMsg);

                // Also notify crew members directly if not connected to room
                crewInfo.crew.members.forEach(member => {
                    const mId = member.user.toString();
                    if (mId !== myId.toString()) {
                        emitToUser(mId, "newCrewMessage", formattedCrewMsg);
                    }
                });

                successfulTargets.push({ id: target.id, type: 'crew', messageId: newMsg._id.toString() });
                createdMessages.push(formattedCrewMsg);
            } else {
                skippedTargets.push({ id: target.id, type: target.type, reason: "Unknown target type" });
            }
        }

        return res.json({
            success: true,
            forwardedCount: successfulTargets.length,
            successfulTargets,
            skippedTargets,
            messages: createdMessages
        });

    } catch (error) {
        console.error("forwardMessage error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// Edit a message (sender only, within 15 minutes of createdAt, text/caption only, non-system)
export const editMessage = async (req, res) => {
    try {
        const { id } = req.params;
        const myId = req.user._id;
        const { text } = req.body;

        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Valid message ID is required" });
        }

        const msg = await Message.findById(id);
        if (!msg) {
            return res.status(404).json({ success: false, message: "Message not found" });
        }

        // Ownership: Sender only
        if (msg.senderId.toString() !== myId.toString()) {
            return res.status(403).json({ success: false, message: "Forbidden: You can only edit your own messages" });
        }

        // Not allowed if deleted
        if (msg.isDeletedForAll || (msg.deletedFor || []).some(uid => uid.toString() === myId.toString())) {
            return res.status(400).json({ success: false, message: "Deleted messages cannot be edited" });
        }

        // Not allowed on system messages
        const isSystem = Boolean(
            msg.isSystem ||
            msg.senderRole === "System" ||
            (msg.crewId && msg.text && msg.text.includes("assembled!") && msg.text.includes("Let's set sail!"))
        );
        if (isSystem) {
            return res.status(400).json({ success: false, message: "System messages cannot be edited" });
        }

        // Enforce 15-minute time window from createdAt on server
        const diffMs = Date.now() - new Date(msg.createdAt).getTime();
        if (diffMs > 15 * 60 * 1000) {
            return res.status(400).json({ success: false, message: "Editing time limit (15 minutes) has expired" });
        }

        // Must have valid non-empty trimmed text with max 5000 chars (not allowed on forwarded-only media without text)
        if (typeof text !== "string") {
            return res.status(400).json({ success: false, message: "Text content must be a valid string" });
        }
        const trimmedText = text.trim();
        if (!trimmedText) {
            return res.status(400).json({ success: false, message: "Text content is required to edit message" });
        }
        if (trimmedText.length > 5000) {
            return res.status(400).json({ success: false, message: "Message text cannot exceed 5000 characters" });
        }

        msg.text = trimmedText;
        msg.editedAt = new Date();
        await msg.save();

        const payload = {
            messageId: msg._id.toString(),
            text: msg.text,
            editedAt: msg.editedAt,
            senderId: msg.senderId.toString(),
            receiverId: msg.receiverId ? msg.receiverId.toString() : null,
            crewId: msg.crewId ? msg.crewId.toString() : null
        };

        if (msg.crewId) {
            io.to(`crew_${msg.crewId}`).emit("messageEdited", payload);
        } else {
            if (msg.receiverId) emitToUser(msg.receiverId, "messageEdited", payload);
            emitToUser(msg.senderId, "messageEdited", payload);
        }

        res.json({ success: true, message: msg });
    } catch (error) {
        console.error("editMessage error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete a message (delete for me or delete for everyone)
export const deleteMessage = async (req, res) => {
    try {
        const { id } = req.params;
        const myId = req.user._id;
        const { deleteType } = req.body;

        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Valid message ID is required" });
        }

        if (!["for_me", "for_everyone"].includes(deleteType)) {
            return res.status(400).json({ success: false, message: "deleteType must be 'for_me' or 'for_everyone'" });
        }

        const msg = await Message.findById(id);
        if (!msg) {
            return res.status(404).json({ success: false, message: "Message not found" });
        }

        // Verify access to message
        let hasAccess = false;
        let isCrewCaptain = false;
        if (msg.crewId) {
            const crew = await Crew.findById(msg.crewId);
            if (crew) {
                isCrewCaptain = crew.captain.toString() === myId.toString();
                const isMember = isCrewCaptain || crew.members.some(m => m.user.toString() === myId.toString());
                hasAccess = isMember;
            }
        } else {
            hasAccess = msg.senderId.toString() === myId.toString() || msg.receiverId?.toString() === myId.toString();
        }

        if (!hasAccess) {
            return res.status(403).json({ success: false, message: "Forbidden: You do not have access to this message" });
        }

        const isSender = msg.senderId.toString() === myId.toString();

        if (deleteType === "for_me") {
            // Delete for me: hides only for this user
            await Message.findByIdAndUpdate(id, { $addToSet: { deletedFor: myId } });

            // Notify all active sessions of this user
            emitToUser(myId, "messageDeleted", {
                messageId: msg._id.toString(),
                deleteType: "for_me",
                chatId: msg.crewId ? msg.crewId.toString() : (isSender ? msg.receiverId?.toString() : msg.senderId.toString())
            });

            return res.json({ success: true, deleteType: "for_me", messageId: msg._id.toString() });
        }

        if (deleteType === "for_everyone") {
            // Reject if already deleted for everyone
            if (msg.isDeletedForAll) {
                return res.status(400).json({ success: false, message: "This message has already been deleted for everyone" });
            }

            // System messages cannot be deleted for everyone
            const isSystem = Boolean(
                msg.isSystem ||
                msg.senderRole === "System" ||
                (msg.crewId && msg.text && msg.text.includes("assembled!") && msg.text.includes("Let's set sail!"))
            );
            if (isSystem) {
                return res.status(400).json({ success: false, message: "System messages cannot be deleted for everyone" });
            }

            // Permissions: sender within 1 hour, or crew captain
            let canDeleteForEveryone = false;
            if (isSender) {
                const diffMs = Date.now() - new Date(msg.createdAt).getTime();
                if (diffMs <= 60 * 60 * 1000) {
                    canDeleteForEveryone = true;
                } else if (!isCrewCaptain) {
                    return res.status(400).json({ success: false, message: "Delete for everyone time limit (1 hour) has expired" });
                }
            }

            if (msg.crewId && isCrewCaptain) {
                canDeleteForEveryone = true;
            }

            if (!canDeleteForEveryone) {
                return res.status(403).json({ success: false, message: "Forbidden: You do not have permission to delete this message for everyone" });
            }

            // Track if receiver has seen it before deletion
            const wasUnseen = !msg.seen;

            // Delete for everyone: keep document, clear text and image, and clear reactions
            msg.isDeletedForAll = true;
            msg.deletedAt = new Date();
            msg.text = "";
            msg.image = null;
            msg.reactions = [];
            await msg.save();

            const payload = {
                messageId: msg._id.toString(),
                deleteType: "for_everyone",
                crewId: msg.crewId ? msg.crewId.toString() : null,
                senderId: msg.senderId.toString(),
                receiverId: msg.receiverId ? msg.receiverId.toString() : null,
                wasUnseen: wasUnseen
            };

            if (msg.crewId) {
                io.to(`crew_${msg.crewId}`).emit("messageDeleted", payload);
            } else {
                if (msg.receiverId) emitToUser(msg.receiverId, "messageDeleted", payload);
                emitToUser(msg.senderId, "messageDeleted", payload);
            }

            return res.json({ success: true, deleteType: "for_everyone", messageId: msg._id.toString() });
        }

    } catch (error) {
        console.error("deleteMessage error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// React to a message with an emoji (toggle off if same emoji, replace if different)
export const reactToMessage = async (req, res) => {
    try {
        const { id } = req.params;
        const myId = req.user._id;
        const { emoji } = req.body;

        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Valid message ID is required" });
        }

        if (!emoji || typeof emoji !== "string") {
            return res.status(400).json({ success: false, message: "Valid emoji string is required" });
        }

        const trimmedEmoji = emoji.trim();
        if (!trimmedEmoji || trimmedEmoji.length > 8 || /[<>]/.test(trimmedEmoji)) {
            return res.status(400).json({ success: false, message: "Invalid emoji. Must be at most 8 characters without HTML." });
        }

        const msg = await Message.findById(id);
        if (!msg) {
            return res.status(404).json({ success: false, message: "Message not found" });
        }

        // Access control: sender or receiver, or crew member
        let hasAccess = false;
        if (msg.crewId) {
            const crew = await Crew.findById(msg.crewId);
            if (crew) {
                const isCaptain = crew.captain.toString() === myId.toString();
                const isMember = isCaptain || crew.members.some(m => m.user.toString() === myId.toString());
                hasAccess = isMember;
            }
        } else {
            hasAccess = msg.senderId.toString() === myId.toString() || msg.receiverId?.toString() === myId.toString();
        }

        if (!hasAccess) {
            return res.status(403).json({ success: false, message: "Forbidden: You do not have access to this message" });
        }

        // Restrictions: Not allowed on deleted-for-everyone messages, deleted-for-me messages, or system messages
        if (msg.isDeletedForAll || (msg.deletedFor || []).some(uid => uid.toString() === myId.toString())) {
            return res.status(400).json({ success: false, message: "Reactions are not allowed on deleted messages" });
        }

        const isSystem = Boolean(
            msg.isSystem ||
            msg.senderRole === "System" ||
            (msg.crewId && msg.text && msg.text.includes("assembled!") && msg.text.includes("Let's set sail!"))
        );
        if (isSystem) {
            return res.status(400).json({ success: false, message: "Reactions are not allowed on system messages" });
        }

        // Check if user already has this exact reaction (toggle off) or another reaction (replace)
        const existingReaction = (msg.reactions || []).find(r => {
            const rUid = r.userId?._id ? r.userId._id.toString() : r.userId?.toString();
            return rUid === myId.toString();
        });

        if (existingReaction && existingReaction.emoji === trimmedEmoji) {
            // Remove reaction atomically
            await Message.updateOne(
                { _id: id },
                { $pull: { reactions: { userId: myId } } }
            );
        } else {
            // Atomic update: pull any existing reaction for myId, then push new reaction
            await Message.updateOne(
                { _id: id },
                { $pull: { reactions: { userId: myId } } }
            );
            await Message.updateOne(
                { _id: id, isDeletedForAll: { $ne: true } },
                {
                    $push: {
                        reactions: {
                            userId: myId,
                            emoji: trimmedEmoji,
                            createdAt: new Date()
                        }
                    }
                }
            );
        }

        const updatedMsg = await Message.findById(id).populate("reactions.userId", "_id fullName profilePic");
        const updatedReactions = updatedMsg ? updatedMsg.reactions : [];

        const payload = {
            messageId: msg._id.toString(),
            reactions: updatedReactions,
            crewId: msg.crewId ? msg.crewId.toString() : null,
            senderId: msg.senderId.toString(),
            receiverId: msg.receiverId ? msg.receiverId.toString() : null
        };

        if (msg.crewId) {
            io.to(`crew_${msg.crewId}`).emit("messageReaction", payload);
        } else {
            if (msg.receiverId) emitToUser(msg.receiverId, "messageReaction", payload);
            emitToUser(msg.senderId, "messageReaction", payload);
        }

        res.json({ success: true, reactions: updatedReactions });
    } catch (error) {
        console.error("reactToMessage error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};