# 右上审核区插画来源

这些是社区鲸鱼娘同人素材，不是 DeepSeek 官方角色或官方授权标志。
图片原文件未修改；客户端仅用 CSS 调整显示尺寸。嵌入 `client.js` 的图片数据保留各自许可，不随程序代码重新授权。

## 立绘与挥手表情

- `welcome.webp`：来自 [JAdpp/dsh-whale-galgame 的 maid-left.webp](https://github.com/JAdpp/dsh-whale-galgame/blob/main/assets/default/maid-left.webp)。
- `advice.webp`：来自 [同仓库 whale-cheerful.webp](https://github.com/JAdpp/dsh-whale-galgame/blob/main/assets/default/whale-cheerful.webp)。
- 作者链：上善（原鲸鱼娘）→ ZipZipPipe（加入 DeepSeek 元素的女仆再设计）→ Small-tailqwq / dsh-deep-whale / maid-atelier（开源立绘）→ JAdpp / dsh-whale-galgame（表情制作）。
- 上善：[Bilibili](https://space.bilibili.com/4456176) / [Pixiv](https://www.pixiv.net/users/62155430)。ZipZipPipe：[Bilibili](https://space.bilibili.com/4168597) / [Pixiv](https://www.pixiv.net/users/18604994)。
- 素材许可：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)。保留署名，仅按非商业条款使用；改作须遵守相同许可。
- 完整上游说明保留在 `UPSTREAM-NOTICE.md`；上游许可证与署名原文见本目录 `licenses/`。

## 小型 Q 版

- `waiting.png`：来自 [1190fasheqi/dafeiyu-pet 的 sprites/正面.png](https://github.com/1190fasheqi/dafeiyu-pet/blob/main/sprites/%E6%AD%A3%E9%9D%A2.png)。
- 仓库作者 1190fasheqi，仓库声明 MIT，原文保留在 `licenses/dafeiyu-pet-LICENSE.txt`。该声明不单独证明原角色的权利归属。

## 本地打包

运行 `node scripts/embed-review-art.mjs` 会将这三张图片原始字节嵌入客户端，避免运行时向图片网站发请求。
空状态使用立绘；标题使用 Q 版；每条审核详情展开时使用挥手表情，收起时隐藏。标题轻微呼吸浮动，详情表情错开轻轻摇摆；系统减少动态效果时静止。所有图片均为装饰，不参与模型输入和审核判断。

下方原话的单条点评也使用相同蓝色建议区和小精灵：仅点评生成成功、卡片展开时显示角色；生成中或失败时只展示状态。原话正文与摘要不添加装饰。
