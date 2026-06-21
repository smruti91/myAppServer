import { createServer } from 'node:http'
import { createApplication } from './app'
import { bootstrapDatabase } from './db'
import { loadFaceModels } from './app/utils/lodeModels'

async function main() {
    try {
        const server = createServer(createApplication())
        const PORT: number = parseInt(process.env.PORT ?? '8000', 10)
        await bootstrapDatabase();
        loadFaceModels();
        server.listen(PORT, () => {
            console.log(`Http server is running on PORT ${PORT}`)
        })
    } catch (error) {
        console.log(`Error starting http server`)
        throw error
    }
}

main()