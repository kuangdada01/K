package top.kuangdada.k.core.designsystem.component

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * 输入框容器样式。
 *
 * [Outlined] 是默认（表单/搜索）；[Inset] 是设计稿「消息对话」里的聊天输入条：
 * **凹陷底 + 无描边 + 药丸形**。注意文件头那条"不要凹陷底"的结论只适用于
 * "凹陷底直接落在 bgPage 上"（#E9EFE9 vs #EEF2EE 只有 1.04:1）；
 * 聊天输入条是落在一整条 `surface`（白/深卡片）上的，凹陷底与容器对比足够，
 * 反而是描边在细长的输入条里显得"框感"太重。
 *
 * [Plain] 供「外层已经有卡片容器」的场景（设计稿「发布弹层」的正文块）：
 * **完全无底、无描边、无内边距、无最小高度** —— 容器与内边距由调用方的卡片负责，
 * 否则会出现「卡片里再套一个带描边的输入框」的双层框。
 */
enum class KTextFieldVariant { Outlined, Inset, Plain }

/**
 * 输入框（设计稿「三 · 核心组件」输入 / 状态一行：默认 · 聚焦）
 *
 * **Outlined 刻意没有「凹陷底」**：旧 Web 版的 `--bg-input #E9EFE9` 与页面底 `#EEF2EE`
 * 只有 **1.04:1**，人眼读不出输入框边界（设计稿实测结论）。所以：
 *
 *   · 默认态 = `surface` 底 + `borderStrong` 1px 描边
 *   · 聚焦态 = 同一底色，描边换成 `focusRing` 2px（= 键盘焦点环，两者同源）
 *
 * 搜索框（药丸形）用 [shape] = KRadius.pill；表单输入框用 KRadius.control。
 *
 * @param interactionSource 可选。**只在 `Plain` 变体下才需要传**：Plain 不画容器，
 *   也就没有"聚焦时把描边换成 focusRing"这件事 —— 想要聚焦反馈，就得由**外层**容器来画，
 *   而外层必须知道内层到底有没有聚焦。默认 null 时组件自建一个（既有调用方行为不变）。
 * @param minLines 可选。**空框至少要占几行**（透传给 `BasicTextField`）。
 *   多行框（个人简介这类）要"空着也留 2 行"时**必须用它**：
 *   给外层容器加高度（`height`/`heightIn`/`requiredHeight`）都没用 ——
 *   `BasicTextField` 内部按自己的内容与 `minLines` 撑高，不看外面的高度约束。
 */
@Composable
fun KTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    singleLine: Boolean = true,
    enabled: Boolean = true,
    forceFocused: Boolean = false,
    shape: Shape = RoundedCornerShape(KRadius.control),
    variant: KTextFieldVariant = KTextFieldVariant.Outlined,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    textStyle: TextStyle? = null,
    focusRequester: FocusRequester? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    interactionSource: MutableInteractionSource? = null,
    minLines: Int = 1,
) {
    KTextFieldContainer(
        isEmpty = value.isEmpty(),
        modifier = modifier,
        placeholder = placeholder,
        enabled = enabled,
        forceFocused = forceFocused,
        shape = shape,
        variant = variant,
        textStyle = textStyle,
        leading = leading,
        trailing = trailing,
        sharedInteraction = interactionSource,
    ) { interaction ->
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().then(
                if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier
            ),
            enabled = enabled,
            singleLine = singleLine,
            minLines = minLines,
            textStyle = resolvedTextStyle(textStyle),
            cursorBrush = SolidColor(KTheme.colors.accent),
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            interactionSource = interaction,
        )
    }
}

/**
 * [TextFieldValue] 版本 —— 需要**在光标处插入**内容时用它（表情面板、话题 `#`）。
 *
 * `String` 版本拿不到 selection，只能往末尾追加；"在框里选表情"这种设计
 * （设计稿「发布弹层」要求表情直接落在正文框里）必须知道光标位置。
 */
@Composable
fun KTextField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    singleLine: Boolean = true,
    enabled: Boolean = true,
    forceFocused: Boolean = false,
    shape: Shape = RoundedCornerShape(KRadius.control),
    variant: KTextFieldVariant = KTextFieldVariant.Outlined,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    textStyle: TextStyle? = null,
    focusRequester: FocusRequester? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    interactionSource: MutableInteractionSource? = null,
    minLines: Int = 1,
) {
    KTextFieldContainer(
        isEmpty = value.text.isEmpty(),
        modifier = modifier,
        placeholder = placeholder,
        enabled = enabled,
        forceFocused = forceFocused,
        shape = shape,
        variant = variant,
        textStyle = textStyle,
        leading = leading,
        trailing = trailing,
        sharedInteraction = interactionSource,
    ) { interaction ->
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().then(
                if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier
            ),
            enabled = enabled,
            singleLine = singleLine,
            minLines = minLines,
            textStyle = resolvedTextStyle(textStyle),
            cursorBrush = SolidColor(KTheme.colors.accent),
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            interactionSource = interaction,
        )
    }
}

@Composable
private fun resolvedTextStyle(override: TextStyle?) =
    (override ?: KType.body).copy(color = KTheme.colors.textPrimary)

/** 两个重载共用的外壳：底 / 描边 / 内边距 / 占位符 / 选中高亮 */
@Composable
private fun KTextFieldContainer(
    isEmpty: Boolean,
    modifier: Modifier,
    placeholder: String?,
    enabled: Boolean,
    forceFocused: Boolean,
    shape: Shape,
    variant: KTextFieldVariant,
    textStyle: TextStyle?,
    leading: (@Composable () -> Unit)?,
    trailing: (@Composable () -> Unit)?,
    /** 调用方要自己读聚焦态时传进来（见 `KTextField` 的 `interactionSource` 参数） */
    sharedInteraction: MutableInteractionSource?,
    field: @Composable (MutableInteractionSource) -> Unit,
) {
    val c = KTheme.colors
    // remember(sharedInteraction)：调用方换了 source 就要重建，否则会一直读旧源上的聚焦态
    val interaction = remember(sharedInteraction) {
        sharedInteraction ?: MutableInteractionSource()
    }
    val focused by interaction.collectIsFocusedAsState()
    val isFocused = forceFocused || focused

    val borderWidth = when (variant) {
        KTextFieldVariant.Plain -> 0.dp
        KTextFieldVariant.Inset -> 0.dp
        KTextFieldVariant.Outlined -> if (isFocused) 2.dp else 1.dp
    }
    val borderColor = if (isFocused) c.focusRing else c.borderStrong
    val containerColor = when (variant) {
        KTextFieldVariant.Plain -> Color.Transparent
        KTextFieldVariant.Inset -> c.surfaceSunken
        KTextFieldVariant.Outlined -> c.surface
    }

    // 选中文字的高亮跟着强调色走（未设时 Compose 默认是主题 primary，这里是显式钉住）
    val selectionColors = TextSelectionColors(
        handleColor = c.accent,
        backgroundColor = c.accent.copy(alpha = 0.30f),
    )

    CompositionLocalProvider(LocalTextSelectionColors provides selectionColors) {
        Row(
            modifier = modifier
                .fillMaxWidth()
                // Plain：**完全不画容器**（不裁剪、不填底、不描边、不留内边距）。
                // 早期这里仍然 `clip(shape)`，于是正文/光标贴着 10dp 圆角的切角处会被切掉一块
                // —— 用户看到的就是"圆角里还有一块填充、光标显示不全"。
                // 容器（圆角/描边/内边距）由外层卡片负责，内层只留文字本身。
                .then(
                    if (variant == KTextFieldVariant.Plain) {
                        Modifier
                    } else {
                        Modifier
                            .clip(shape)
                            .background(containerColor)
                            .then(
                                if (borderWidth > 0.dp) Modifier.border(borderWidth, borderColor, shape)
                                else Modifier
                            )
                            .defaultMinSize(minHeight = KDimens.minTouchTarget)
                            .padding(
                                horizontal = KSpacing.md,
                                // Inset 是细长药丸（设计稿实测 44dp 高），垂直内边距要收一档，
                                // 否则会撑到 46dp、与右侧发送按钮不等高
                                vertical = if (variant == KTextFieldVariant.Inset) KSpacing.xs else KSpacing.sm,
                            )
                    }
                ),
            // Plain 是"外层卡片撑高、正文从顶部往下写"的形态（发布弹层正文块）：
            // 这里必须靠上对齐 —— Row 默认 CenterVertically，会让正文在卡片里**垂直居中**，
            // 表现出来就是"输入的字跑到中间去了"（用户实测反馈）。
            verticalAlignment = if (variant == KTextFieldVariant.Plain) {
                Alignment.Top
            } else {
                Alignment.CenterVertically
            },
            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            if (leading != null) leading()
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.TopStart) {
                if (isEmpty && placeholder != null) {
                    Text(
                        text = placeholder,
                        style = textStyle ?: KType.body,
                        color = c.textMuted,
                    )
                }
                field(interaction)
            }
            if (trailing != null) trailing()
        }
    }
}
