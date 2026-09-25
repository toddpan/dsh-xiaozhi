/**
 * @dsh-external/dsh-web-service - HTTP Router & Dispatcher
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiResponse, WebServiceConfig } from './types.js';
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>, body: any) => void | Promise<void>;
export interface RouteEntry {
    method: string;
    pattern: RegExp;
    paramNames: string[];
    handler: RouteHandler;
    /** true = 跳过 JSON 解析，把原始请求体 Buffer 交给 handler（文件上传用） */
    rawBody?: boolean;
}
export interface RouteOptions {
    rawBody?: boolean;
}
export declare class HttpRouter {
    private config;
    private routes;
    constructor(config: WebServiceConfig);
    add(method: string, pathPattern: string, handler: RouteHandler, options?: RouteOptions): void;
    get(pathPattern: string, handler: RouteHandler): void;
    post(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void;
    put(pathPattern: string, handler: RouteHandler): void;
    patch(pathPattern: string, handler: RouteHandler): void;
    delete(pathPattern: string, handler: RouteHandler): void;
    dispatch(req: IncomingMessage, res: ServerResponse, basePath?: string): Promise<boolean>;
    private setCorsHeaders;
}
/** 发送 JSON 格式响应 */
export declare function sendJson<T>(res: ServerResponse, statusCode: number, payload: ApiResponse<T>): void;
/** 读取请求体为 JSON */
export declare function readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<any>;
/** 读取请求体为原始 Buffer（文件上传用） */
export declare function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer>;
/** 开启 SSE 流式通道 */
export declare function initSseStream(res: ServerResponse): {
    send: (event: string, data: any) => void;
    close: () => void;
};
