import { AUDIO_PROMPT_RULE, DIALOGUE_DELIVERY_RULE, DIALOGUE_LANGUAGE_RULE, DIALOGUE_VOICE_IDENTITY_RULE } from './audioPromptPolicy';
import {
  LEGACY_MOSE_JIANGHU_NSFW_DETAIL_RULES_V0_6_7,
  MOSE_JIANGHU_NSFW_DETAIL_RULES,
} from './nsfwPromptRules';
import { STORY_CAUSALITY_RULE } from './storyCausalityRules';
import { VIDEO_ACTION_CHOREOGRAPHY_RULE } from './videoActionChoreographyRules';

/** One source contract for the rule library and the live converter. */
export const VIDEO_CONVERSION_STORY_RULE = '把小说叙述整理成具体可见的画面与人物行动，保留原有身份、关系、因果、事件结果及对白。只改需要视频化的叙述，已有清楚可拍的描述可以沿用，不为制造字面差异重写。人物说出口的原话、画外音、通信和明确的心灵交流不属于需要删改的小说修辞；按原文方式保留，不要求说话人必须出现在当前画面。图片只约束对应的可见身份、场景或构图，不替代剧情事实。';

/** Exact retired text for request-time compatibility and historical migration. */
export const LEGACY_VIDEO_DIALOGUE_RULE = '先依据 requiredDialogues 安排完整对白，再组织相应画面、回应和停顿。requiredDialogues 是整段原剧情的发言记录，逐句保留原话、原语言和说话人；同一句在原文真实说了两次就保留两次，重复的原文摘录不是新增播放次数。允许在自然停顿处跨相邻镜头接续一句，也允许边行动边说话，不得按固定字数/秒、固定开口留白或镜头动作数量裁句、删后半句、改成旁白摘要。某镜没有分配对白可写“台词：无”，不能理解为每镜必须重复全部对白。requiredDialogues 中有对白但局部草稿缺失时，以完整原剧情为准。';

export const VIDEO_DIALOGUE_RULE = '先阅读 sourceStoryContent 完整剧情，由你自行识别真实对白、说话人、画外音或通信，并区分标牌文字、内心叙述和说话语气；再安排相应画面、回应和停顿。逐句保留原话、原语言和说话人；同一句在原文真实说了两次就保留两次，重复的原文摘录不是新增播放次数。允许在自然停顿处跨相邻镜头接续一句，也允许边行动边说话，不得按固定字数/秒、固定开口留白或镜头动作数量裁句、删后半句、改成旁白摘要。某镜没有分配对白可写“台词：无”，不能理解为每镜必须重复全部对白。局部草稿遗漏时以完整原剧情为准，在本次回答内自检并修正后返回完整正文；不依赖本地预先抽取的发言名单。';

/** Exact former wording for historical factory-preset fingerprints only. */
export const LEGACY_VIDEO_DIALOGUE_STAGING_RULE_V1_7_0 = '逐句把声音与画面绑定：写明可复用的说话人名称、依据已知人物设定的声线、本镜内的发话起止时刻或清楚的先后关系，以及画内发声、画外发声、通信或心灵交流方式。画内发声时，让口型确实属于该说话人；能看到其面部时交代可辨的说话口型。真实的背影、远景或画外发声照常保留，并说明声源所在位置与方向，不强迫人物为说话转身或走到前景，不把画外音改成旁人台词。说话期间同镜其他人物保持各自的倾听、行动或反应，未分配该句的人不替说、不随这句张口；若原文确有接话、插话或重叠发声，分别标明归属与时序。人物称谓或画面前后顺序不能替代声源归属；不得只因男性在近景、女性在远景，就把女性对白交给男性。保留原话、语言及原有情绪，未知声线不得凭名字擅自编造。';

/** Shared AI instructions: these describe staging, never local semantic acceptance gates. */
export const VIDEO_DIALOGUE_STAGING_RULE = `${LEGACY_VIDEO_DIALOGUE_STAGING_RULE_V1_7_0}${DIALOGUE_VOICE_IDENTITY_RULE}`;

export const VIDEO_SPATIAL_CONTINUITY_RULE = '每镜分别保留朝向、空间关系与镜首镜尾状态：用已知地标和实际目的地说明世界中的行进方向，区分人物朝向、画面中的左右/远近运动与摄影机所在位置和轴线一侧，写清同伴前后关系、视线目标及必要的入画出画位置。相邻镜头逐项承接前镜结尾，不能只在第1镜交代空间、后续镜头丢掉方向。同一路径上的正面与背面改变、运动方向改变或越轴，须由可见转身、已交代的摄影机换位/运动、过渡镜头或剧情明确的时间跳跃解释；摄影机换位不等于人物掉头。既定剧情没有转身时保持已确认的行进目标，不为补救冲突虚构掉头、瞬移或新事件。走路、被牵或被拖，且这次路程还没走完、原文没有写本人倒退或折返时，这一镜的路是场景里已经能走的那一条：平地、踏步、坡道、门口，或绕开楼梯、栏杆、墙、桌和另一个人的空处。每一步的鞋底落在这条路上的下一点。身体跟着这条路升高、降低或拐弯。直线穿过这些实体不是这条路。平地且路上没有实体时，才朝目的地迈步，胸口和迈出的脚朝这个方向。英文写成 She follows the open path already in the shot. Each sole meets the next point on that path. Her body rises, drops, or turns with the path。同一个姓名在这一镜只有一个身体。后面的走路、到达、挥手、近景和参考图都改这一个身体。参考图只提供这一个身体的脸和衣服。两种状态写成较后的那一种：人已经在近景里，步子就落在这一个身体的脚上；路程已经走完，远处不再有一个还在走的人。英文写成 This named person remains one body. Later sentences change that same body. The reference image keeps the face and clothes of that body。平地且路上没有实体时，英文写成 She keeps stepping toward the destination. Her chest and the foot she steps with face that destination. The camera moves backward in front of her at her pace. Her face stays toward the person ahead。没有前方的人时，脸留在行进方向。这一镜里已经在的楼梯、栏杆、墙、门框、桌和另一个人，都留住自己的体积。迈出的鞋底落在可走的那一层表面上，踏步、地面或平台。身体从这些实体旁边的空处走。近处的实体挡住身体被挡住的那一段。手扶栏杆时，手掌留在栏杆朝人的这一面。英文写成 Her sole meets the walkable surface. Her body stays in the open space beside that solid piece. The solid piece keeps its volume. The nearer solid hides the part of her body it covers。栏杆、扶手和墙留在身体旁边。鞋底落在踏步或地面上。手扶时，手掌留在栏杆朝人的这一面，栏杆上沿留在手的高度，腰和髋留在栏杆内侧的空处。原文写了坐上或跨上栏杆时，身体才留在栏杆上。英文写成 Her sole meets the stair tread or the floor. The railing stays beside her. Her palm meets the side toward her, and the rail top stays at her hand. Her waist and hips stay in the open space inside the railing。这一段里走来、下楼、进门、见面或把东西交到对方面前已经在前面的镜头发生过，后面的镜头保持那个已经完成的状态。人留在见面后的那一处，已经交给对方的东西留在接过的人身上。后一镜只改机位，或接着见面之后的动作。英文写成 She remains where she already stopped beside her. The walk in stays finished. The camera cuts to a closer view of the two of them。推近、跟拍、要看正面、注意力、目光和脚下只改观察，不换人。大厅里已经在的人，推近、把注意力、目光或脚下交给其中一个人时，仍留在原文的位置上，并且仍在画面里。英文写成 Xiao Wu remains on the stone platform, still in the frame. Tang San remains where this shot already placed him, still in the frame. The camera moves closer to the Grand Elder and stops at his raised hand。姓名和位置换成这一镜已经写出的。只有原文写了离开，或这一镜只要这张脸时，才写谁不在画面里。正脸参考图锁住五官、衣服，以及这张图上的尾巴、兽耳、翅膀、角和爪。这些附肢只留在已绑定的那一个姓名身上。这一镜已经看见通常被衣服盖住的部位时，盖住它的仍是这个人身上这一套的那一件，腰头敞开，这件布褪到该部位下面。原来扣住这件的腰带保持松开。上衣、靴、手套和另一人的衣服保持本镜已有状态。原文已经写了掀起、褪到膝或脱在身侧时，沿用那个程度。原文写了留着这件、隔着布或只看布下的形状时，这件仍然扣好，形状留在布下面。英文写成 The same piece over that part remains the costume already on that person. Its fastening stays open and the cloth rests below that part. The coat, boots, gloves, and the clothes of the other person remain as this shot already states. A degree already written in the source remains that degree. When the source keeps that piece closed, that piece stays fastened and the shape remains under the cloth。英译写成 A tail, animal ears, wings, horns, or claws remain on the named person who has them. Each named person remains in the one place already written.跟在某人后面时，胸口朝那个人的后背。不把 chest facing forward、bound fronts 或 facing the camera 写成赶路方向。原文已经写出谁在前、谁跟着，而且没有写超车或换位时，后面的镜头仍是这个先后。他们沿同一条路排成一列。领路的人留在最前，胸口和迈出的脚朝目的地。下一个人留在他身后，胸口朝他的后背。再下一个人留在前一人身后。英文写成 They remain in one file along the path. The leader remains ahead, his chest and stepping foot facing the destination. The next person remains behind that leader, chest toward that leader\'s back. A later side view or a view of a face changes only the camera. The order along the path stays the same。姓名换成这一列已经写出的人。回头只转头，人仍留在这一列的原位。前面、后面、in front、behind 必须写在谁前面、谁后面。走在前面是沿路在那个人前面，不是离镜头更近。原文写了超车或换位，才改这一列的先后，并写明停稳后谁在谁身后。后面每一镜开头用同一句再写一次先后。每人两条手臂、两只手。正在做事的那只手写明是谁的、掌心朝哪、握住什么，前臂从他的肩连到这只掌。原文只写了一只手时，剩下的那只手留在他另一条手臂末端，前臂从肩连到这只掌。原文写了两件事时，第一只手留在已经写下的接触上，第二件事用他剩下的那一只手，前臂从另一条手臂连到那只掌。五指留在这两只已经写下的掌上。近景里这两只手仍是这两条手臂的末端，前臂伸出画面回到他的肩。英文写成 He has two arms. One hand remains on the contact already written, and that forearm runs from his shoulder to that palm. The other action uses his remaining hand, and that forearm runs from his other arm to that palm. When only one hand is written, his other hand remains at the end of his other arm. Five fingers remain on those palms。迈出的那只脚的鞋底落到这一镜的地面上，停住，另一只脚再迈。英文写成 The sole of the stepping foot meets the floor and stays until the other foot passes。眼睛保持参考图里的大小，这一镜自然眨一次，看的是原文的人。说话时上下牙留在嘴唇里面，舌头留在口腔里。原文写了伸舌或舔，舌头才离开口腔。英文写成 Her eyes remain the size in the reference and blink once. Her upper and lower teeth remain inside her lips. Her tongue remains inside her mouth。近处的人挡住远处的人被挡住的那一段。英文写成 The nearer body hides the part of the farther body it covers. The farther chest does not show through her torso。地面、窗或镜子里是同一个人、同一套衣服。英文写成 The reflection is the same person in the same clothes. It is not a second body。头发从第一帧就保持原文的盘法或散发，不在这一镜中途改发型。原文写了一次解开，才写那一次并写明散开后停在哪。英文写成 Her hair remains tied as in the first frame。兔耳、尾巴、发冠、项圈留在原文的位置。英文写成 Her rabbit ears remain on her head. The collar remains around the neck。参考图只提供这个人的脸、头发和衣服。英文写成 The reference supplies only this person. The corridor remains the shot place。这一镜只有原文写出的人。英文写成 Only the named people are in this shot. No one else enters from a doorway or forms in the background。这一镜只有一盏主光，颜色和方向保持这一句。每人一道影子，落在这盏灯的反方向。英文写成 One lamp keeps this color and this direction. Each person has one shadow away from that lamp。每个姓名整段用项目已确认的性别代词。。推近只改摄影机。线、绳或衣带从原文的起点连到原文的终点。英文写成 The thread remains from his palm to her wrist。换机位只改看得见的一段，两端留在原处。推、跟、摇都写成 The camera pushes in with small amplitude at slow speed toward her shoulder and stops at a medium shot。落点是这一镜已经在身上的部位，停在中景或近景。锁脸、衣服和队列，不锁构图。袍子、袖子和裙摆留在手臂和躯干外面，袖子顺着那条手臂。头发连在头皮上，拖在迈步的反方向。英文写成 The robe remains outside the arm and the torso. The sleeve follows that arm。这一镜写了几团光、几条线、几件兵器，换到侧面或高处仍是这个数目。英文写成 Exactly two threads remain。掌心朝原文的东西或路线，不朝镜头，除非原文写掌心朝镜头。每一镜最后一句写停稳的姿势：谁在谁身后、哪只手握着什么、这句台词说完后嘴闭合。下一镜第一句用同样的姿势接上，再写这一镜的新动作。参考图已经锁了脸和衣服时，后镜只写姓名、队列位置和这一镜的动作。胡须留在领口外面，从下巴连到胸口。英文写成 His beard remains outside the collar, from his chin to his chest。裙摆贴着她的腿。英文写成 The hem stays against her legs。落地后脚掌贴着地面并停住。英文写成 Her soles meet the stone and she stops. Her weight stays on her soles。原文已经写出身高差时，高的人保持高出一头。英文写成 The Grand Elder remains a head taller than Xiao Wu。姓名换成这一镜已经写出的人。视线还在肩线前面时只转头。视线或机位要过到肩膀后面时，肩膀跟着头转，直到下巴留在肩膀前面，胸口跟着这次转向。英文写成 Her shoulders turn with her head until her chin stays in front of her shoulder. Her chest stays with that turn。原文没有写慢动作时，动作保持实时速度。英文写成 The action stays at real-time speed。这一镜只写一个主运镜，第二种运镜放到下一镜。英文写成 This shot has one camera move. The camera pushes in with small amplitude at slow speed toward her shoulder and stops。原文是固定镜头时写成 The camera holds this frame. It stays at this distance。绕拍时脚、髋和肩留在路线朝向，背景滑过画面。英文写成 The camera arcs around her with small amplitude at slow speed. Her feet, hips and shoulders stay facing the path. The doorway slides across the frame。机位用 The camera 开头的运镜句。举手另写双臂，句子里不出现机器。主观镜头写成 POV。原文要举起的东西从这一镜开头就在那只手里。英文写成 The letter is already in her hand. She raises that hand。手先碰到门、兵器或杯子那块已经写出的表面，然后物体停在碰完的状态。英文写成 His palm meets the door. The door swings open and stays open。一件事写一次，后面只写停住后的状态。跌倒写成短路径，地面留在画面里。英文写成 Her rear foot skids, her knees fold, and her soles meet the stone. She stops. Dust rises after she stops. Her hair settles after her body stops。原文要看见全身走路时，镜头按她的步速拉出。英文写成 The camera pulls out with large amplitude at her walking speed. Her whole body stays in the frame。坐下时大腿贴着座位。英文写成 Her thighs meet the seat. She stays seated。环抱时手臂留在对方后背外面。英文写成 His arms remain around her back, outside her torso。原文有疤、印或饰物时，左右和部位用原文的，后面每一镜用同一句。英文写成 The scar remains on her right cheek, below the outer corner of that eye。远景不把小标记写成这一镜的主体。手朝镜头、又不是这一镜的主体时，手留在腰侧。英文写成 That hand stays beside her waist, palm toward the path. Five fingers remain separated on that palm。同一镜里的身体动作按 begins, next, then, stops 排先后。已有首帧和尾帧、原文没有分成多镜时，用一镜走到尾帧。英文写成 One shot carries the change from the first frame to the last frame。两人相对时，眼睛互相看着。英文写成 Her eyes meet his eyes。对方在画外时，眼睛看向那个人所在的一侧，脸留在四分之三侧。英文写成 Her eyes look toward Tang San, off to her right. Her face stays three-quarters toward him。姓名和左右换成这一镜的人。原文写了看镜头，才让眼睛朝镜头。同一侧机位时，人留在画面左或画面右。英文写成 Xiao Wu remains on screen-left, facing screen-right. Tang San remains on screen-right, facing screen-left。反打时她面向镜头，桌子朝镜头伸，原来在她身后的墙仍在她身后。英文写成 In the reverse shot she faces the lens. The table runs toward the lens. The wall that was behind her stays behind her。不写角度和厘米。身上的左侧和画面左侧分开。戒指和眼镜留在原文的那一侧，后面每一镜用同一句。英文写成 The ring remains on his right hand. His glasses remain on his face。下一镜开头，杯子、剑或门保持上一镜已经停住的状态。英文写成 The cup remains in her right hand at the start of this shot. It stays in that hand until she sets it down。原文写了放下、入鞘或关上，才写那一次，并写明停在哪里。手上的小动作以手为主语，关节按顺序动。英文写成 His hand turns the cover. The wrist turns, the fingers lift, and the fingertips meet the cover. The cover stays between his thumb and fingers。手肘留在那条手臂的外侧。英文写成 His elbow stays bent on the outside of that arm。这一镜的事是手上的接触时，景别靠近那只手。英文写成 This shot stays close on her hand and the cup。兵器从肩到已经写出的那块表面，停在上面。英文写成 The blade travels from his shoulder to that named surface and stops against it。裙摆跟着迈步，脚停住之后裙摆才落下。英文写成 The hem follows her step and settles after the foot stops。雾、尘土或雨留在原文的地方，在人身后或器物上。英文写成 Steam rises from the cup and stays above the cup。主动作在镜头中段完成，最后停住这个姿势。英文写成 She finishes the reach in the middle of the shot. The last moment holds that pose。低机位从腿前看时，膝比脸更靠近镜头。英文写成 Her knees stay closer to the lens than her face. Her face stays farther back in the frame。原文写出情绪时，只写成一个看得见的动作，例如眉聚拢、眼睛仍看着那个人。英文写成 His brows stay drawn together. His eyes stay on Tang San。这一镜有几个人，每个人只留在原文的一个位置。英文写成 Exactly three people remain. Xiao Wu remains on the platform. The Grand Elder remains the one person leaning over her. Tang San remains one body, standing away from the platform。人数、姓名和位置换成这一镜已经写出的。每个人两条手臂、两条腿。两只手各留在一条手臂末端，第二件事用剩下的那一只手。英文写成 Each person has two arms and two legs. Xiao Wu\'s two legs stay on the platform, one on each side of her hips. Her one hand stays on the stone, and that forearm runs from her shoulder to that palm. Her other hand remains at the end of her other arm. The Grand Elder\'s one hand stays on the platform beside her hip. His remaining hand stays on her waist, and that forearm runs from his other arm to that palm。部位换成原文已经写出的。这一镜已经改成仰卧时，只保留仰卧。原文是仰躺、压上来或从正面进入，且没有写他在她身后、跪伏、趴着或侧躺时，写成她仰躺着，背留在身下的垫面上，胸口朝上。双膝弯曲分开，朝向他，双脚留在这垫面上。他留在她两腿之间，面对她，胸口对着她的胸口，髋对着她的髋。进入从她骨盆前面发生。根留在他的腹股沟。龟头穿过她两腿之间的阴唇，留在阴道里面，指向阴道深处。茎身从他的腹股沟穿过阴道口，连到留在阴道里面的龟头。露在体外的只有腹股沟到阴唇这一截。英文写成 She remains on her back on the cushion. Her back remains on the cushion and her chest remains toward the ceiling. Her knees stay bent and open toward him, and her feet remain on the cushion. He remains between her thighs, facing her, his chest toward her chest and his hips toward her hips. The shaft enters from the front of her pelvis. The base remains at his groin. The glans passes through her labia and remains inside her vagina, pointing along the vaginal canal. The shaft runs from his groin through her vaginal opening to the glans inside her vagina. Only the length between his groin and her labia remains outside her body。原文只写按回某件家具、没有写按在肩、背或后脑时，写成把她放到这件家具上，背留在垫面上。不补肩背，也不写成 presses her back。要看见相接或阴茎时，用这一个斜侧面固定中景，同时看见脸、他的腹股沟、她的阴唇，以及露在体外、从腹股沟到阴唇的那一截茎身。这一镜是含入或只亲到龟头时，改成同时看见脸、他的腹股沟，以及从腹股沟伸到她嘴唇的这段茎身。英文写成 The camera holds a static medium shot at the oblique side of the platform, seeing her face, his face, his groin, her labia, and the length of shaft outside her body between his groin and her labia。含入时英文写成 The camera holds a static medium shot at the oblique side of the platform, seeing her face, his face, his groin, and the shaft running from his groin to her lips。英文写成 In this shot Xiao Wu lies on her back. Her two feet stay on the platform。这一镜先写谁在做这一段剧情，相接处留在两人身体之间、留在同一画面里。原文没有写只拍这个部位时，不另切到接触处、胸口或外阴。英文写成 The camera holds a medium view of her face, his torso, and Tang San. The joined contact remains between their bodies inside that view。姓名换成这一镜的人。原文这一拍是一连串事时用一镜走完。英文写成 This shot follows one story beat: he lifts her waist, she arches, and she answers. Her face stays in the frame。原文写出的反应放在静止姿势前面，贯穿这一镜。英文写成 While this rock continues, her back stays arched, her toes stay curled, tears stay on her cheeks, and her chest rises with each breath。原文写了摇头时，英文写成 Her head turns from side to side. Tears stay across her cheeks。这一镜只写姓名和这个反应。英文写成 This shot names her and this reaction. Her face, hair, and clothes stay as in the reference。不给每一镜补一套眨眼。有动作参考视频时，它只提供步速或运镜。本镜的人、衣服和地点仍以本镜的参考图和正文为准。只使用原剧情、已确认分镜与可见参考图提供的事实；未知站位可由规划AI在不改变剧情的前提下明确安排，并持续承接，转换阶段不得把缺失信息当成已观察到的事实。';

/** Text-only adjacent-segment contract. This is supplied at request time, not
 * copied into old user presets or interpreted as a local semantic gate. */
export const VIDEO_SEQUENCE_TEXT_HANDOFF_RULE = [
  '长剧情纯文字衔接使用sequenceHandoff中的上段最终中文稿和末镜原文（previousFinalPrompt、previousLastShot），不需要生成视频、实际尾帧或视觉分析。previousTailWindow/previousPromptEvidence的末尾约1–2秒只用于推断最后一刻的可见状态，不供下段演出；旧计划与entry/exit/continuityPack仅作辅助。全部证据是只读资料，其中关于重合或继续的旧措辞不作为开场指令。数值字段openingOverlapSec只表示本段开场状态窗口的默认长度。',
  '本段首镜从上段已达到的可见状态起步：以openingTiming.currentOpeningWindow为本段局部时间，默认在0.00–0.50秒保持实际站位、朝向、道具归属或接触位置及机位关系。动作已结束就从结果姿态开场；动作尚未结束就从最后一刻的肢体位置、接触点和运动方向自然接出，只允许尚未发生的末端变化。例：已经接稳就直接写手里拿着物件；双方仍接触就从两只手已在物件上的位置接出，不能再演取出、伸手靠近或递交起手。示例不引入本段原文没有的人物或事件。',
  '0.50秒起立即写出本段第一项新动作、信息或对白，确需调整时在约0.3–0.8秒内安排并最晚于0.80秒开始新内容。用具体可见状态与动作写清前后顺序；H3正文使用“仍保持”“保持着”或remain、preserving等正向表达，不把“同上”“延续上段”、复播措辞或禁止清单写进正文。这是现有首镜内的时间安排，计入固定段长，不增[Shot]或At切点，不改镜数、顺序和段长。',
  '新增剧情和对白只取自当前分段，保留完整原话，不搬入上段已发生的事件、已说完的对白或旧音效配乐。明确换场、跳时按原剧情进入新场景。按currentReferences重新绑定Subject/Picture编号，保留当前段时码。',
].join('\n');

export const VIDEO_SEQUENCE_TEXT_HANDOFF_UNLABELLED_ACTOR_RULE = '若首镜末态中的必要人物未列入本段既有H3的Subject定义，仍保留此人在交接边界已到达的站位、姿态与道具接触，不借用其他人的Subject/Picture标签。只在首镜必要范围按前稿明确原名和已给定的公开角色资料写身份、衣着；本段已有主体继续使用本段对应标签。不虚构参考来源、外观、衣着或私密细节，不新增Subject/Picture编号、图片槽或无关人物。仅在末态确实有人物接触或共同持物时写出该关系，后续动作从本段来源取得。';

export const VIDEO_SEQUENCE_TEXT_HANDOFF_PLANNING_RULE = '相邻段一起设计出口和入口。entryState、exitState、transitionHint、continuityPack写明切换前一刻已达到的站位、朝向、机位、道具接触和运动阶段。下段现有首镜内默认0.00–0.50秒从末态起步，未完成的运动从实际位置和方向接出，0.50秒起推进本段新内容，最多不能超过0.80秒；在action/purpose/transition明确开场状态及本段第一项新内容，不为旧动作安排另一次起手、行走、交接或对白。开场窗口计入固定段长，不新增镜头或切点，不复制sourceShotIds/sourceBeatIds，不改变唯一归属、段数、时长或边界，不新增事件或配乐。首段直接从自身剧情开场，换场或跳时按原剧情处理。此处使用剧情及最终文字提示词作依据。';

export const VIDEO_SEQUENCE_TEXT_HANDOFF_TRANSLATION_RULE = '有sequenceHandoff时，忠实翻译已确认中文首镜的可见开场状态和随后本段第一项新动作。英文H3以remain、preserving等正向表达保留人物位置、动作阶段和已建立的接触关系；未完成的运动从中文描述的实际位置接出。按中文保留已确认的开场窗口和新内容起点，如0.00–0.50秒保持末态、从0.50秒起开始新动作，或明确调整且最晚0.80秒的起点。上段末1–2秒只供取证，不翻入本段正文。英文只修翻译遗漏和歧义，不把末态翻成整段动作，不重新分配时间、不新增[Shot]/At切点或引入前稿对白和标签；相对时间安排照译，不自造时码。';

/** Request-time scope rule, deliberately separate from historic factory preset
 * strings: wardrobe/content decisions remain with the same configured AI. */
export const VIDEO_WARDROBE_SCOPE_RULE = '逐镜核对衣着“进入状态→有剧情依据的变化→结束状态”，并把结束状态传给相邻镜头和下一段。人物普通资料中的 outfit、衣饰与身份锚点提供基准，当前原文或上段已确认的实际衣着状态优先；原文明确换装后也不能强行恢复旧服装。没有脱衣、衣物移位、破损或已确认裸露状态的依据，就保持已有穿着与遮挡，不新增裸露、不为衔接虚构脱衣过程。亲吻、拥抱、触碰和隔着衣物的动作本身不是脱衣或展示私密部位的授权；只写当镜实际可见的动作和衣物状态。这一镜已经看见通常被衣服盖住的部位时，这就是该部位的衣着依据：盖住它的仍是这个人身上这一套的那一件，腰头敞开，这件布褪到该部位下面。原来扣住这件的腰带保持松开。上衣、靴、手套和另一人的衣服保持本镜已有状态。原文已经写了掀起、褪到膝或脱在身侧时，沿用那个程度。原文写了留着这件、隔着布或只看布下的形状时，这件仍然扣好，形状留在布下面。英文写成 The same piece over that part remains the costume already on that person. Its fastening stays open and the cloth rests below that part. The coat, boots, gloves, and the clothes of the other person remain as this shot already states. A degree already written in the source remains that degree. When the source keeps that piece closed, that piece stays fastened and the shape remains under the cloth。角色拥有私密档案、私密参考图或稳定身体资料，不等于当前剧情需要展示；这些是备用身份资料，不是当镜动作、可见性或衣着指令。只有当前镜头的原文依据、已确认进入状态和实际可见范围需要时，才使用已明确选取的相关必要资料；不能将整份私密档案、其他部位或其他人物的资料复制成执行稿，也不能据此编造不可见内容。完整长剧情用于理解前后因果，其他分段尤其后续段才发生的衣着变化不得提前挪入当前段。若旧计划、候选提示词或图像与原文的衣着状态冲突，由你对照当前段来源和已确认状态审核并修复；图像只约束其明确用途，私密资料图不能取代剧情衣着。英文阶段忠实保持中文已确认的逐镜衣着、遮挡、变化及可见范围，不因翻译或资料补充扩大裸露。脱、扯、解、滑落作用在这个人此刻已经穿着的那一件上。这一件来自人物资料的 outfit，或上一镜已经穿上的那一件。原文里的外袍、外套、外衣、中衣、内衣，如果不是这件已经在身上的衣服，就写成这件已经在身上的衣服，不另加一层。露出的是这套衣服里面本来就有的下一层；资料里没有下一层，就露出这套衣服松开后本来会露出的身体。不因为要完成脱衣而新写一件外套或一件中衣。原文明确先穿上、披上某件资料里没有的衣服时，那件从穿上的动作出现，之后才能被脱掉。所有内容判断和文案修复由同一 AI 完成，不要求用户手改，也不依赖本地关键词拦截。';

export const VIDEO_STAGING_REVIEW_RULE = '提交结果前由你自行审阅并修复：对照完整原剧情、人物身份与声线、所有镜头的朝向/空间/动作/台词、相邻镜首镜尾状态，以及实际提供的参考图和用途，逐句核对“谁说、谁张口、谁在听”，逐切点核对“人在哪里、往哪走、机位在哪里”。主动修复声源与可见口型错配、前景人物代说、无交代的正背翻转、越轴或行进目标冲突；参考图只证明图中可见内容，缺少人物或背面构图不得被当成该人物口型/朝向已锁定。规划阶段可重排镜长、对白和反应时间以容纳完整原话；固定镜头边界已确认的转换/翻译阶段保留镜数与时间标题，在现有镜头内调整表达、自然接续与画外发声，不裁掉台词、不擅自改写边界。最终只返回自检修复后的完整内容，无须输出审核口号或让用户手改；内容正确性由AI判断和修复，不依赖本地关键词匹配、字数配额或语义拦截。';

export const VIDEO_PROMPT_FOCUS_RULE = '把每镜的可见动作、说话人/口型/听者、朝向与本镜空间放在对应镜头内，不能藏在开头总说明里让后镜自行继承。由AI合并重复的全局人物外貌与身份资料，在格式允许时只完整定义一次并在后续用同一名称引用，保留每镜必要的可辨识特征与实际状态变化；不要逐镜重复无变化的整段身体结构清单。精简只针对重复说明，不按固定字符上限截断，不删剧情、对白、身份事实、声源归属、机位或连续性依据。中文稿与英文稿保持相同的逐镜声源和空间约束，对白仍按原剧情语言保留。';

export const VIDEO_LOCAL_TIME_RULE = '镜头标题中的起止秒数是整段视频坐标；台词或音效如果标注“第Xs”，X从当前镜头开始计算，而不是从整段视频开始。每镜数据含 globalStartSec、globalEndSec、durationSec 和 localTimeRangeSec。例如标题【4.5s-9s】的镜长是4.5秒，本镜可用0–4.5秒：全片第6.5秒的事件应写成本镜“第2s”。根据实际动作、对白回应关系安排时刻，不将全片时刻直接复制到镜内，不机械把越界数字夹到镜尾。并非每个小动作都需要独立音效或小数时间点，没有必要标时的声音可直接写自然同步关系。';

export const VIDEO_SCENE_STYLE_RULE = '每镜描述一个清楚的主事件，可按剧情包含必要的动作与回应，不规定机械的1/2/3阶段或每秒字数额度。空间说明人物、物体的实际位置关系，光影和摄影写对当前画面有用的信息；不要求每镜凑齐前中后景、色温K数字或完整身体力学清单。固定镜数与边界已经给定时，在这些镜头内组织内容，不另行要求拆镜；未给定时才由规划阶段决定镜头。保持已选风格、人物特征及前后状态，不虚构道具、事件或声音。';

/** Current request instructions; retired exports above remain fingerprint-stable. */
export const VIDEO_CONTINUOUS_SCENE_STYLE_RULE = '每镜依据既定观看任务组织完整连续场面，一个镜头可以承载相互因果的多个动作、对白与回应；事件条目不等于镜头条目，主事件不意味着每镜只许一次动作。保持真实行动顺序、强度、接触与反馈，不规定机械的1/2/3阶段、每秒字数或动作配额。空间只表达必要的人物、物体与通路关系，光影和摄影忠实转写既定画面；不要求每镜凑齐前中后景、色温K数字或完整身体力学清单。转换、H3转写与翻译保留给定镜数、顺序、时间标题、机位、运镜与观察对象，不在这些阶段拆镜、合镜或重选摄影；摄影选择只属于明确的源头导演任务。';

/** User-selected picture style and directing manner, written once into the delivered body. */
export const VIDEO_SELECTED_STYLE_DELIVERY_RULE = 'selectedPictureStyle 是用户已选的画面风格，selectedDirectorStyle 是用户已选的导演调度。H3 正文只写画面风格一次。没有画面风格时不另编画风。不把导演调度写进 H3 正文，不在开头补机位、景别、跟随、固定、推近或前景遮挡。镜头里已经写好的运镜保持原句。不改写成另一套媒介或年代，不逐镜重复，不把「视觉风格锚点」「风格预设视觉」和〔〕标签写进正文。六字段把画面风格接在首镜光影的场景光之后，写成「画面风格：…。」场景光仍写该镜的时间、天气和光源。full-reference 的 H3 在 detailed_description 的 [Shot 1] 之前写这一句。三字段 H3 把同一句写在 [Shot 1] 正文开头。Seedance 仍把画面风格和导演调度各写一次在视频规格里。参考图职责保持身份、场景或通用参考，不改标为视觉风格参考。若 H3 正文还没有画面风格，只补这一句，不改写其余镜头。正常速度不写速度词。身体动作里已经写成的缓慢起伏保持原句。已保存的成片和提示词不因此自动改写。';

export const selectedVideoStyleFields = (input: {
  visualStyle?: string;
  directorStyleSummary?: string;
}): { selectedPictureStyle?: string; selectedDirectorStyle?: string } => {
  const picture = input.visualStyle?.trim() || '';
  const director = input.directorStyleSummary?.trim() || '';
  return {
    ...(picture ? { selectedPictureStyle: picture } : {}),
    ...(director ? { selectedDirectorStyle: director } : {}),
  };
};

export const VIDEO_STAGING_TRANSCRIPTION_RULE = '在源头导演阶段，将真实说话人、听者、世界行动关系与观看任务一起落实到逐镜动作和摄影；在同一次输出内保持完整对白、原语言、具名声源、口型、朝向、空间及镜首镜尾状态。普通转换、H3转写、参考更新、翻译和已有confirmed中文只忠实传递既定排程与摄影，表达遗漏或歧义用原稿已经成立的关系澄清，不另选机位、运镜、景别或切点，不用新增转身、瞬移或新动作圆场。显式dialogue-repair只在当前任务明确授权的发话与必要排程修改内配置摄影，不借此从头重套导演风格或重新分配剧情。参考图只承担给定身份、场景或构图职责，缺少人物、背面或静态表情不更改已有演出；最终仅返回当前格式的完整正文，不追加检查器、审核调用或重试。';

export const VIDEO_CONVERSION_FORMAT_RULE = '输出逐镜正文。每镜保留输入时间标题，按主体、空间、光影、镜头、台词、音效六字段组织，字段间使用中文分号。主体使用可复用名称及“正在 [可见动作]”结构；多个动作可用“→”连接，但不为凑数量补动作。其余字段用简明自然描述；有对白时把原话放在台词字段，推荐第Xs @说话人：“原话”，原文是裸对白也照常保留，不把标牌或说话语气注释当成台词。音效可用环境层-[...] 动作层-[...] 情绪层-[...]表达，无事件和无配乐如实写无。不要输出规则解释、分析、JSON或代码围栏。';

export const VIDEO_CONVERSION_EXAMPLE = '仅用于说明格式与两种时间坐标的示例（不得把示例人物或台词搬入实际剧情）：\n【4.5s-9s】 主体：@林舟（专注）[朝向：门口同伴] 正在 [抬手示意同伴停步]（发出提醒）；空间：同伴站在林舟前方的门口；光影：门外自然侧光；镜头：中景固定；台词：第2s @林舟：“等我回来。”；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]';

/** Two supplied schedules illustrate continuity, never a shot-count or duration quota. */
export const VIDEO_CONTINUOUS_CONVERSION_EXAMPLE = [
  '以下仅示意如何转写已经给定的连续排程，人物、时间和镜数不是实际剧情或配额；按当前原文与源头镜头替换，不把例子当成要求新增切点。',
  '同镜容纳进入、互动与回应的示例：',
  '【0s-12s】 主体：@林舟正在 [推门进入，沿原通路走到门内同伴身侧，抬手示意停步，说明去向；@同伴听完转向林舟回应，林舟点头沿通路离开]；空间：门侧通路与两人的相对位置保持可读；光影：沿用门外自然侧光；镜头：门侧双人中景固定，进入、交谈和离开均在这份取景内连续发生；台词：第3s-5s @林舟：“我去找钥匙。” 第6s-8s @同伴：“我在这里等你。”；音效：环境层-[无] 动作层-[进门落脚的自然短声] 情绪层-[无配乐]',
  '原排程确有关键线索揭示时转写有意义切换的示例：',
  '【0s-8s】 主体：@林舟正在 [沿桌边寻找钥匙，停在抽屉前；@同伴注意到抽屉内一角折叠纸条并指出]；空间：桌边两人与抽屉的关系保持可读；光影：沿用室内光源；镜头：桌侧双人中景，观察两人的寻找与指出；台词：第5s-7s @同伴：“这里有张纸条。”；音效：环境层-[无] 动作层-[抽屉开启的短声] 情绪层-[无配乐]',
  '【8s-12s】 主体：@林舟正在 [接续前镜抽屉已打开的状态，取出纸条并展开，露出原文确有的地址线索]；空间：手、纸条与已打开的抽屉保持同一位置关系；光影：同一室内光源；镜头：纸条近景，原中景无法读清的关键线索成为新观看任务；台词：无；音效：环境层-[无] 动作层-[展开纸张的自然短声] 情绪层-[无配乐]',
].join('\n');

/** Exact v1.3.0 default retained only for lossless built-in migration. */
export const LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_3_0 = [
  VIDEO_CONVERSION_STORY_RULE,
  LEGACY_VIDEO_DIALOGUE_RULE,
  DIALOGUE_LANGUAGE_RULE,
  VIDEO_SCENE_STYLE_RULE,
  AUDIO_PROMPT_RULE,
  VIDEO_LOCAL_TIME_RULE,
].join('\n\n');

/** Exact v1.4.0 defaults retained only for lossless built-in migration. */
export const LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_4_0 = [
  LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_3_0.split(LEGACY_VIDEO_DIALOGUE_RULE).join(VIDEO_DIALOGUE_RULE),
  LEGACY_MOSE_JIANGHU_NSFW_DETAIL_RULES_V0_6_7,
].join('\n\n');
export const LEGACY_DEFAULT_VIDEO_CONVERSION_OUTPUT_V1_4_0 = [VIDEO_CONVERSION_FORMAT_RULE, VIDEO_CONVERSION_EXAMPLE].join('\n\n');

/** Exact previous system: historical factory fingerprints must not acquire
 * new choreography rules when the live defaults evolve. */
export const LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_7_0 = [
  LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_4_0,
  STORY_CAUSALITY_RULE,
  DIALOGUE_DELIVERY_RULE,
  LEGACY_VIDEO_DIALOGUE_STAGING_RULE_V1_7_0,
  VIDEO_SPATIAL_CONTINUITY_RULE,
  VIDEO_STAGING_REVIEW_RULE,
  VIDEO_PROMPT_FOCUS_RULE,
].join('\n\n');
export const DEFAULT_VIDEO_CONVERSION_SYSTEM = [
  LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_7_0
    .replace(LEGACY_MOSE_JIANGHU_NSFW_DETAIL_RULES_V0_6_7, MOSE_JIANGHU_NSFW_DETAIL_RULES)
    .replace(LEGACY_VIDEO_DIALOGUE_STAGING_RULE_V1_7_0, VIDEO_DIALOGUE_STAGING_RULE)
    .replace(VIDEO_SCENE_STYLE_RULE, VIDEO_CONTINUOUS_SCENE_STYLE_RULE)
    .replace(VIDEO_STAGING_REVIEW_RULE, VIDEO_STAGING_TRANSCRIPTION_RULE),
  VIDEO_ACTION_CHOREOGRAPHY_RULE,
].join('\n\n');
export const VIDEO_CAUSALITY_OUTPUT_RULE = '结合本段原文与只读理解上下文核对行动者→动作→对象→结果，保留有依据的攻击来源和具名目标；反应特写也不能让攻击因果消失，不把比喻变成新能力。中文与英文保持同一因果。';
/** Exact former default output for historical factory fingerprints only. */
export const LEGACY_DEFAULT_VIDEO_CONVERSION_OUTPUT_V2_1_0 = [
  VIDEO_CONVERSION_FORMAT_RULE,
  DIALOGUE_DELIVERY_RULE,
  '在主体和台词字段落实每句声源、口型与听者状态；在主体、空间和镜头字段落实本镜朝向、行进目标、机位与前后承接。每镜都保留必要约束，不新增审核报告字段。',
  VIDEO_CAUSALITY_OUTPUT_RULE,
  VIDEO_PROMPT_FOCUS_RULE,
  VIDEO_CONVERSION_EXAMPLE,
].join('\n\n');

export const DEFAULT_VIDEO_CONVERSION_OUTPUT = [
  VIDEO_CONVERSION_FORMAT_RULE,
  DIALOGUE_DELIVERY_RULE,
  '在主体和台词字段落实每句声源、口型与听者状态；在主体、空间和镜头字段落实本镜朝向、行进目标、机位与前后承接。每镜都保留必要约束，不新增审核报告字段。',
  VIDEO_CAUSALITY_OUTPUT_RULE,
  VIDEO_PROMPT_FOCUS_RULE,
  VIDEO_CONTINUOUS_CONVERSION_EXAMPLE,
].join('\n\n');

/** Remove only the known contradictory legacy instructions at request time.
 * Custom presets stay stored exactly as authored; no broad text rewriting. */
export const stripLegacyVideoQuotaRules = (value: string): string => String(value || '')
  .split(LEGACY_VIDEO_DIALOGUE_RULE).join(VIDEO_DIALOGUE_RULE)
  .split(VIDEO_SCENE_STYLE_RULE).join(VIDEO_CONTINUOUS_SCENE_STYLE_RULE)
  .split(VIDEO_STAGING_REVIEW_RULE).join(VIDEO_STAGING_TRANSCRIPTION_RULE)
  .split(VIDEO_CONVERSION_EXAMPLE).join(VIDEO_CONTINUOUS_CONVERSION_EXAMPLE)
  .split(/\r?\n/u)
  .filter((line) => !/^\s*(?:对白按自然中文约4\.5字\/秒估算|目标总时长无法容纳完整长句时，只能按原句标点截取)/u.test(line))
  .join('\n');
