package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 正文 + 话题（#关键词）
 * ============================================================
 * 服务端发布时用 `extractTags()` 从正文里抽 `#话题` 入库（`shared/src/utils/tag.ts`），
 * 正文本身保留原文 —— 所以像「你好#风景」这种"话题直接粘在正文屁股上"的写法很常见。
 * 用户反馈两点，这里一次解决：
 *  1. **关键词跟正文隔开一点**：正文里把 `#话题` 摘出去，正文下面单独一行展示话题；
 *  2. **关键词可点，点了搜相关帖子**：话题渲染成可点的胶囊（accent 底 + accent 字），
 *     点击回调交给上层去打开搜索页的该话题结果。
 *
 * ⚠️ 正则/上限必须与服务端 `TAG_REGEX` / `MAX_TAG_LENGTH` / `MAX_TAGS_PER_POST` **完全一致**，
 * 否则会出现"正文里被摘掉的词其实没入库"这种对不上的情况（超长话题服务端会整条忽略 →
 * 这里也必须把它留在正文里，不能摘走）。
 */
private val TAG_REGEX = Regex("#([\\p{L}\\p{N}_-]+)")
private const val MAX_TAG_LENGTH = 30
private const val MAX_TAGS_PER_POST = 10

/** 正文与话题拆开后的结果 */
data class TaggedParts(
    /** 摘掉话题后的正文（话题可能夹在中间，摘掉后会留下多余空格，这里做了规整） */
    val body: String,
    /** 话题名（不含 #，已去重、已按服务端规则过滤） */
    val tags: List<String>,
)

/**
 * 拆正文与话题。规则与服务端 `extractTags` 对齐：
 *  · 话题长度 > [MAX_TAG_LENGTH] 的**整条忽略**（不截断）→ 留在正文里；
 *  · 去重（保留首次出现）；
 *  · 最多 [MAX_TAGS_PER_POST] 个，多出来的留在正文里。
 */
fun splitTags(text: String): TaggedParts {
    if (text.isBlank()) return TaggedParts("", emptyList())
    val seen = LinkedHashSet<String>()
    val removedRanges = mutableListOf<IntRange>()
    for (match in TAG_REGEX.findAll(text)) {
        val tag = match.groupValues[1]
        if (tag.isEmpty() || tag.length > MAX_TAG_LENGTH) continue
        if (seen.contains(tag)) {
            // 重复话题：也摘掉（展示上没必要重复），但不再计一次
            removedRanges += match.range
            continue
        }
        if (seen.size >= MAX_TAGS_PER_POST) continue
        seen += tag
        removedRanges += match.range
    }
    if (removedRanges.isEmpty()) return TaggedParts(text.trim(), emptyList())

    val body = buildString {
        var cursor = 0
        for (range in removedRanges) {
            if (range.first > cursor) append(text, cursor, range.first)
            cursor = range.last + 1
        }
        if (cursor < text.length) append(text, cursor, text.length)
    }
    // 摘掉话题后可能留下 "你好 "、" \n" 这类尾巴：按行规整再合并多余空行
    val cleaned = body
        .lines()
        .joinToString("\n") { it.trimEnd() }
        .replace(Regex("\n{3,}"), "\n\n")
        .trim()
    return TaggedParts(cleaned, seen.toList())
}

/**
 * 正文 + 话题胶囊。话题跟正文之间留 [KSpacing.xs] 间距（用户要求"隔开一点"）。
 *
 * **话题要跟正文分开摆的场景用 [TaggedBody] / [TaggedChips]**（见它们的注释）：
 * 首页卡片要求「关键词放图片下面、文案不动」，这时正文和话题不在同一个位置，
 * 不能再让这个函数把两者绑在一个 Column 里。
 *
 * @param onTagClick null 时话题只展示不可点（例如未登录场景仍可搜，所以调用方一般都传）
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TaggedDescription(
    text: String,
    style: TextStyle = KType.body,
    color: Color = KTheme.colors.textSecondary,
    maxLines: Int = Int.MAX_VALUE,
    onTagClick: ((String) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val parts = remember(text) { splitTags(text) }
    androidx.compose.foundation.layout.Column(
        modifier = modifier,
        // 正文与话题之间留一档（用户要求"隔开一点"）。
        // 用 Column 的 spacedBy 而不是在两者之间插 Spacer：话题不存在时
        // Spacer 就得靠 if 判断，多一层分支；spacedBy 只在"确实有两个孩子"时才生效。
        verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        TaggedBody(parts = parts, style = style, color = color, maxLines = maxLines)
        TaggedChips(parts = parts, onTagClick = onTagClick)
    }
}

/**
 * **只画正文**（不含话题胶囊）。
 *
 * 与 [TaggedChips] 配对使用 —— 两者都吃同一份 [TaggedParts]（调用方 `remember(text) { splitTags(text) }`
 * 拆一次即可，不要各拆一遍）。
 *
 * 为什么要把它们拆开（用户要求「关键词放图片下面，文案不动」）：
 * 首页卡片的新顺序是「正文 → 配图 → 关键词」，正文与话题**中间隔着图片**，
 * 没法再由 [TaggedDescription] 那个 Column 统一渲染。
 */
@Composable
fun TaggedBody(
    parts: TaggedParts,
    style: TextStyle = KType.body,
    color: Color = KTheme.colors.textSecondary,
    maxLines: Int = Int.MAX_VALUE,
    modifier: Modifier = Modifier,
) {
    if (parts.body.isBlank()) return
    Text(
        text = parts.body,
        style = style,
        color = color,
        maxLines = maxLines,
        overflow = if (maxLines == Int.MAX_VALUE) TextOverflow.Clip else TextOverflow.Ellipsis,
        modifier = modifier,
    )
}

/**
 * **只画话题胶囊（关键词）**，不画正文。没有话题时什么都不画。
 *
 * 配色：accent 字 + `accentSoft` 底的胶囊；可点 → 搜该话题的相关帖子。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TaggedChips(
    parts: TaggedParts,
    onTagClick: ((String) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    if (parts.tags.isEmpty()) return
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
    ) {
        parts.tags.forEach { tag ->
            val shape = RoundedCornerShape(KRadius.pill)
            Text(
                text = "#$tag",
                style = KType.caption,
                color = c.accent,
                maxLines = 1,
                modifier = Modifier
                    .clip(shape)
                    .background(c.accentSoft)
                    .then(
                        if (onTagClick != null) {
                            Modifier.clickable { onTagClick(tag) }
                        } else {
                            Modifier
                        }
                    )
                    .padding(horizontal = KSpacing.xs, vertical = 3.dp),
            )
        }
    }
}
