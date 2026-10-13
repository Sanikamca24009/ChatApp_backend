import mongoose from 'mongoose'
import dns from 'dns'

dns.setServers(['8.8.8.8', '1.1.1.1'])

//Function to connect to the mongodb database

export const connectDB = async() => {
    try{
        mongoose.connection.on('connected',()=> console.log('Database Connected'));

        await mongoose.connect(process.env.MONGODB_URI, {
            dbName: 'chat-app'
        });
    } catch(error){
        console.error("MongoDB connection error:", error);
    }
}