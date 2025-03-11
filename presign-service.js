const express = require('express');
const cors = require('cors');
const { S3Client, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
require('dotenv').config();

const app = express();

// 增加请求大小限制
app.use(express.json({ limit: process.env.MAX_FILE_SIZE || '1024mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.MAX_FILE_SIZE || '1024mb' }));

// 日志中间件
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// 配置 CORS
const corsOptions = {
    origin: process.env.CORS_ORIGINS?.split(',') || [
        'https://r2.vrchat.vip',
        'http://r2.vrchat.vip',
        'https://vrchat.vip',
        'http://vrchat.vip',
        'http://localhost:8080',
        // '*' // 临时添加通配符以允许所有来源（开发环境用）
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Origin',
        'Range',
        'Content-Range',
        'Cache-Control' // 添加这一行，缺少这个头部会导致问题
    ],
    exposedHeaders: [
        'ETag',
        'x-amz-*',
        'Content-Range',
        'Accept-Ranges'
    ],
    credentials: true,
    maxAge: 86400,
    preflightContinue: false,  // 确保预检请求正确处理
    optionsSuccessStatus: 204  // 设置预检请求的成功状态码
};

app.use(cors(corsOptions));

// 添加一个专门处理 OPTIONS 请求的中间件
app.options('*', cors(corsOptions));

// 创建 R2 客户端，增加超时设置
const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 5, // 最大重试次数
    requestTimeout: 300000 // 5分钟超时
});

// 修改 generateSafeFileName 函数
function generateSafeFileName(originalFileName, category) {
    try {
        // 首先确保文件名是从完整路径中提取的
        const baseFileName = path.basename(originalFileName);
        
        // 分离文件名和扩展名
        const lastDotIndex = baseFileName.lastIndexOf('.');
        let baseName, fileExtension;
        
        if (lastDotIndex === -1) {
            baseName = baseFileName;
            fileExtension = '';
        } else {
            baseName = baseFileName.substring(0, lastDotIndex);
            fileExtension = baseFileName.substring(lastDotIndex + 1);
        }
        
        // 添加时间戳，但不编码文件名
        const timestamp = Date.now();
        
        // 构建最终文件名 - 直接使用原始文件名，不进行编码
        const finalFileName = fileExtension ? 
            `${category}/${baseName}_${timestamp}.${fileExtension}` : 
            `${category}/${baseName}_${timestamp}`;
        
        console.log(`[${new Date().toISOString()}] 生成文件名: 原始=${originalFileName}, 处理后=${finalFileName}`);
        
        return {
            key: finalFileName,
            originalNameInfo: {
                originalName: baseName,
                timestamp: timestamp,
                extension: fileExtension
            }
        };
    } catch (error) {
        console.error('生成文件名错误:', error);
        // 错误回退处理
        const timestamp = Date.now();
        const safeName = `${category}/file_${timestamp}`;
        return {
            key: safeName,
            originalNameInfo: {
                originalName: 'file',
                timestamp: timestamp,
                extension: ''
            }
        };
    }
}


// 辅助函数：通过代理包装 URL
function proxyUrl(originalUrl) {
    const corsProxyBaseUrl = process.env.CORS_PROXY_URL || 'https://vrchat.vip/r2-cors-proxy';
    // 确保 originalUrl 不以 / 开头，而 corsProxyBaseUrl 以 / 结尾
    const formattedProxyUrl = corsProxyBaseUrl.endsWith('/') ? corsProxyBaseUrl : `${corsProxyBaseUrl}/`;
    return `${formattedProxyUrl}${originalUrl}`;
}



// 初始化分片上传
app.post('/init-multipart-upload', async (req, res) => {
    try {
        const { fileName, fileType, category } = req.body;
        
        if (!fileName || !category) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        
        // 使用新函数生成文件名
        const fileNameResult = generateSafeFileName(fileName, category);
        const uniqueFileName = fileNameResult.key;
        
        console.log(`[${new Date().toISOString()}] 生成文件名: ${uniqueFileName}, 原文件名: ${fileName}`);
        
        const command = new CreateMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: uniqueFileName,
            ContentType: fileType || 'application/octet-stream',
            ACL: 'public-read',
            CacheControl: 'public, max-age=31536000',
            // 在元数据中保存原始文件名信息
            Metadata: {
                'original-filename': Buffer.from(JSON.stringify(fileNameResult.originalNameInfo)).toString('base64')
            }
        });
        
        const { UploadId } = await s3Client.send(command);
        
        console.log(`[${new Date().toISOString()}] 初始化分片上传: ${uniqueFileName}`);
        
        res.json({
            uploadId: UploadId,
            key: uniqueFileName,
            fileUrl: `${process.env.R2_PUBLIC_URL}${uniqueFileName}`,
            originalNameInfo: fileNameResult.originalNameInfo,
            config: {
                chunkSize: 5 * 1024 * 1024, // 5MB 分片大小
                maxRetries: 3,
                timeout: 300000, // 5分钟超时
                concurrentUploads: 3 // 并发上传数
            }
        });
    } catch (error) {
        console.error('初始化分片上传错误:', error);
        res.status(500).json({ error: '初始化上传失败' });
    }
});

// 获取分片上传URL
// 获取分片上传URL
app.post('/get-part-upload-url', async (req, res) => {
    try {
        const { key, uploadId, partNumber } = req.body;
        
        const command = new UploadPartCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber
        });
        
        const signedUrl = await getSignedUrl(s3Client, command, {
            expiresIn: 3600 * 24 // 24小时有效期
        });
        
        // 辅助函数：通过代理包装 URL
        function proxyUrl(originalUrl) {
            // 不要对原始URL进行编码，因为它已经是预签名的
            const corsProxyBaseUrl = process.env.CORS_PROXY_URL || 'https://vrchat.vip/r2-cors-proxy';
            // 直接拼接，不做额外编码
            return `${corsProxyBaseUrl}/${originalUrl}`;
        }
        
        // 使用代理包装签名URL
        const uploadUrl = proxyUrl(signedUrl);
        
        // 记录URL便于调试
        console.log(`[${new Date().toISOString()}] 分片 ${partNumber} 原始预签名URL: ${signedUrl}`);
        console.log(`[${new Date().toISOString()}] 分片 ${partNumber} 代理后URL: ${uploadUrl}`);

        res.json({
            uploadUrl,  // 添加这个，使用与普通上传相同的键名
            signedUrl: uploadUrl,  // 保持兼容性
            partNumber,
            config: {
                timeout: 300000, // 5分钟超时
                retries: 3
            }
        });
    } catch (error) {
        console.error('获取分片上��URL错误:', error);
        res.status(500).json({ error: '获取上传URL失败' });
    }
});





 
// 完成分片上传
app.post('/complete-multipart-upload', async (req, res) => {
    try {
        const { key, uploadId, parts } = req.body;
        
        const command = new CompleteMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts
            }
        });
        
        await s3Client.send(command);
        console.log(`[${new Date().toISOString()}] 完成分片上传: ${key}`);
        
        res.json({
            success: true,
            fileUrl: `${process.env.R2_PUBLIC_URL}${key}`
        });
    } catch (error) {
        console.error('完成分片上传错误:', error);
        res.status(500).json({ error: '完成上传失败' });
    }
});


// 在 presign-service.js 中添加服务器端分片上传函数
// 服务器端分片上传（作为备用方案）
app.post('/server-upload-large-file', async (req, res) => {
    try {
        const { fileData, fileName, fileType, category } = req.body;
        
        if (!fileData || !fileName) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        
        console.log(`[${new Date().toISOString()}] 开始服务器端上传大文件: ${fileName}`);
        
        // 解码 base64 数据
        let buffer;
        if (fileData.startsWith('data:')) {
            const base64Data = fileData.split(',')[1];
            buffer = Buffer.from(base64Data, 'base64');
        } else {
            buffer = Buffer.from(fileData, 'base64');
        }
        
        // 生成文件名
        const fileNameResult = generateSafeFileName(fileName, category || 'FileMessage');
        const uniqueFileName = fileNameResult.key;
        
        // 初始化分片上传
        const initCommand = new CreateMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: uniqueFileName,
            ContentType: fileType || 'application/octet-stream',
            ACL: 'public-read',
            CacheControl: 'public, max-age=31536000',
            Metadata: {
                'original-filename': Buffer.from(JSON.stringify(fileNameResult.originalNameInfo)).toString('base64')
            }
        });
        
        const { UploadId } = await s3Client.send(initCommand);
        console.log(`[${new Date().toISOString()}] 服务器初始化分片上传: ${uniqueFileName}, uploadId: ${UploadId}`);
        
        // 分片上传
        const chunkSize = 5 * 1024 * 1024; // 5MB
        const chunks = Math.ceil(buffer.length / chunkSize);
        const parts = [];
        
        for (let i = 0; i < chunks; i++) {
            const partNumber = i + 1;
            const start = i * chunkSize;
            const end = Math.min(buffer.length, start + chunkSize);
            const chunk = buffer.slice(start, end);
            
            const uploadCommand = new UploadPartCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: uniqueFileName,
                UploadId,
                PartNumber: partNumber,
                Body: chunk
            });
            
            try {
                const { ETag } = await s3Client.send(uploadCommand);
                parts.push({
                    PartNumber: partNumber,
                    ETag
                });
                console.log(`[${new Date().toISOString()}] 服务器上传分片 ${partNumber}/${chunks} 成功`);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] 服务器上传分片 ${partNumber} 失败:`, error);
                throw error;
            }
        }
        
        // 完成上传
        const completeCommand = new CompleteMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: uniqueFileName,
            UploadId,
            MultipartUpload: {
                Parts: parts
            }
        });
        
        await s3Client.send(completeCommand);
        console.log(`[${new Date().toISOString()}] 服务器完成分片上传: ${uniqueFileName}`);
        
        res.json({
            success: true,
            fileUrl: `${process.env.R2_PUBLIC_URL}${uniqueFileName}`
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] 服务器上传大文件失败:`, error);
        res.status(500).json({ error: `上传大文件失败: ${error.message}` });
    }
});






// 获取普通上传URL（小文件用）
app.post('/get-upload-url', async (req, res) => {
    try {
        const { fileName, fileType, category } = req.body;
        
        if (!fileName || !category) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        
        // 使用新函数生成文件名
        const fileNameResult = generateSafeFileName(fileName, category);
        const uniqueFileName = fileNameResult.key;
        
        console.log(`[${new Date().toISOString()}] 生成文件名: ${uniqueFileName}, 原文件名: ${fileName}`);
        
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: uniqueFileName,
            ContentType: fileType || 'application/octet-stream',
            ACL: 'public-read',
            CacheControl: 'public, max-age=31536000',
            // 在元数据中保存原始文件名信息
            Metadata: {
                'original-filename': Buffer.from(JSON.stringify(fileNameResult.originalNameInfo)).toString('base64')
            }
        });
        

        const signedUrl = await getSignedUrl(s3Client, command, {
            expiresIn: 3600 * 24 // 24小时有效期
        });

        // 使用代理包装 URL
        const uploadUrl = proxyUrl(signedUrl);
        
        // 记录URL便于调试
        console.log(`[${new Date().toISOString()}] 原始预签名URL: ${signedUrl}`);
        console.log(`[${new Date().toISOString()}] 代理后URL: ${uploadUrl}`);
        
        res.json({
            uploadUrl: uploadUrl,
            fileUrl: `${process.env.R2_PUBLIC_URL}${uniqueFileName}`,
            key: uniqueFileName,
            originalNameInfo: fileNameResult.originalNameInfo,
            config: {
                timeout: 300000, // 5分钟超时
                retries: 3
            }
        });
    } catch (error) {
        console.error('获取上传URL错误:', error);
        res.status(500).json({ error: '获取上传URL失败' });
    }
});

// 添加兼容路由，解决404问题
app.post('/api/r2/upload-complete', async (req, res) => {
    try {
        const { key } = req.body;
        
        if (!key) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        
        console.log(`[${new Date().toISOString()}] 通过兼容路由通知上传完成: ${key}`);
        res.json({ 
            success: true,
            fileUrl: `${process.env.R2_PUBLIC_URL}${key}`
        });
    } catch (error) {
        console.error('处理上传完成通知错误:', error);
        res.status(500).json({ error: '处理上传完成通知失败' });
    }
});

// 添加原始版本的上传完成路由
app.post('/upload-complete', async (req, res) => {
    try {
        const { key } = req.body;
        
        if (!key) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        
        console.log(`[${new Date().toISOString()}] 通知上传完成: ${key}`);
        res.json({ 
            success: true,
            fileUrl: `${process.env.R2_PUBLIC_URL}${key}`
        });
    } catch (error) {
        console.error('处理上传完成通知错误:', error);
        res.status(500).json({ error: '处理上传完成通知失败' });
    }
});

app.get('/download/:key(*)', async (req, res) => {
    try {
        // 获取文件路径
        let key = req.params.key;
        
        // 确保key正确格式化
        if (key.startsWith('/')) key = key.substring(1);
        
        // 获取文件元数据，包含原始文件名
        const command = new HeadObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key
        });
        
        const metadata = await s3Client.send(command);
        
        // 从元数据中获取原始文件名信息
        let originalFilename = key.split('/').pop(); // 默认使用key中的文件名部分
        
        if (metadata.Metadata && metadata.Metadata['original-filename']) {
            try {
                const originalNameInfo = JSON.parse(Buffer.from(metadata.Metadata['original-filename'], 'base64').toString());
                // 重建原始文件名（不包含时间戳��
                if (originalNameInfo.extension) {
                    originalFilename = `${originalNameInfo.originalName}.${originalNameInfo.extension}`;
                } else {
                    originalFilename = originalNameInfo.originalName;
                }
            } catch (e) {
                console.error('解析原始文件名错误:', e);
                // 继续使用默认文件名
            }
        }
        
        // 创建下载URL并指定原始文件名
        const getCommand = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            ResponseContentDisposition: `attachment; filename="${encodeURIComponent(originalFilename)}"`
        });
        
        const signedUrl = await getSignedUrl(s3Client, getCommand, {
            expiresIn: 3600 // 1小时有效期
        });

        // 使用代理包装 URL
        // const downloadUrl = proxyUrl(signedUrl);
        // console.log(`[${new Date().toISOString()}] 使用CORS代理获取文件: ${downloadUrl}`);
        // 下载不用代理包装，因为下载没有遇到跨域CORS
        
        // 重定向到签名URL
        res.redirect(signedUrl);
    } catch (error) {
        console.error('下载文件错误:', error);
        res.status(404).json({ error: '文件不存在或无法访问' });
    }
});



// 直接处理图片请求
app.get('/:key(*)', async (req, res) => {
    try {
        // 获取文件路径
        let key = req.params.key;
        
        // 确保key正确格式化
        if (key.startsWith('/')) key = key.substring(1);
        
        // 排除查询参数
        key = key.split('?')[0];
        
        console.log(`[${new Date().toISOString()}] 直接请求图片: ${key}`);
        
        // 创建R2直接访问URL
        const directUrl = `${process.env.R2_PUBLIC_URL}${key}`;
        
        // 设置响应头
        res.set('Cache-Control', 'public, max-age=86400'); // 缓存一天
        res.set('Access-Control-Allow-Origin', '*');
        
        // 使用pipe直接转发请求
        const response = await fetch(directUrl, {
            headers: { 'User-Agent': 'fiora-server' }
        });
        
        if (!response.ok) {
            return res.status(response.status).send(`访问失败: ${response.statusText}`);
        }
        
        // 设置正确的内容类型
        res.set('Content-Type', response.headers.get('Content-Type') || 'image/jpeg');
        
        // 将R2响应数据传递给客户端
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
    } catch (error) {
        console.error('图片代理请求失败:', error);
        res.status(500).send(`服务器错误: ${error.message}`);
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        config: {
            cors: corsOptions,
            uploadConfig: {
                maxFileSize: process.env.MAX_FILE_SIZE,
                chunkSize: '5MB',
                timeout: '5min',
                maxRetries: 3
            },
            endpoints: {
                getUploadUrl: '/get-upload-url',
                uploadComplete: ['/upload-complete', '/api/r2/upload-complete'],
                multipartUpload: {
                    init: '/init-multipart-upload',
                    getPartUrl: '/get-part-upload-url',
                    complete: '/complete-multipart-upload'
                },
                download: '/download/:key'
            }
        }
    });
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] 预签名URL服务已启动，端口: ${PORT}`);
    console.log(`[${new Date().toISOString()}] 服务配置:`, {
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        bucket: process.env.R2_BUCKET_NAME,
        publicUrl: process.env.R2_PUBLIC_URL
    });
});