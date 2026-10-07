package top.kuangdada.k.core.data.api

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import top.kuangdada.k.core.data.model.AuthResponse
import top.kuangdada.k.core.data.model.ForgotPasswordRequest
import top.kuangdada.k.core.data.model.LoginRequest
import top.kuangdada.k.core.data.model.MessageResponse
import top.kuangdada.k.core.data.model.RegisterRequest
import top.kuangdada.k.core.data.model.ResetPasswordRequest
import top.kuangdada.k.core.data.model.SendCodeRequest
import top.kuangdada.k.core.data.model.User

/**
 * 认证接口（server/src/routes/auth.ts），前缀 /api/auth
 *
 * 服务端限流（必须在 UI 上给出反馈，否则用户只会看到"没反应"）：
 *  · /login、/register、/reset-password：15 分钟 10 次
 *  · /send-code、/forgot-password：1 小时 5 次，且同一邮箱 60 秒内不可重发
 */
interface AuthApi {

    @POST("api/auth/send-code")
    suspend fun sendCode(@Body body: SendCodeRequest): MessageResponse

    @POST("api/auth/register")
    suspend fun register(@Body body: RegisterRequest): AuthResponse

    @POST("api/auth/login")
    suspend fun login(@Body body: LoginRequest): AuthResponse

    @POST("api/auth/forgot-password")
    suspend fun forgotPassword(@Body body: ForgotPasswordRequest): MessageResponse

    @POST("api/auth/reset-password")
    suspend fun resetPassword(@Body body: ResetPasswordRequest): MessageResponse

    /** 当前登录用户（用 token 校验，返回的用户信息是数据库实时值） */
    @GET("api/auth/me")
    suspend fun me(): User
}
