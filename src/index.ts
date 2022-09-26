import 'dotenv/config';
import * as fs from 'fs';
import Piscina from 'piscina';
import * as path from 'path';
import { request } from 'undici';
import { v4 as uuid } from 'uuid';
import * as shelljs from 'shelljs';
import { toLower, endsWith, range, first } from 'lodash';
import { App } from '@slack/bolt';

import { InputState } from './util';
import { CoreType, emulate } from './emulate';

const NES = ['nes'];
const SNES = ['sfc', 'smc'];
const GB = ['gb', 'gbc'];
const GBA = ['gba'];

const pool = new Piscina({
  filename: path.resolve(__dirname, path.resolve(__dirname, 'worker.ts')),
  name: 'default',
  execArgv: ['-r', 'ts-node/register']
});

const main = async () => {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    socketMode: true,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN
  });

  await app.start();

  app.message('', async ({ client, message, say }) => {
    if (message.subtype !== "file_share") return;

    const attachment = message.files[0];

    let coreType: CoreType;
    if (NES.find(ext => endsWith(toLower(attachment.name), ext))) {
      coreType = CoreType.NES;
    } else if (SNES.find(ext => endsWith(toLower(attachment.name), ext))) {
      coreType = CoreType.SNES;
    } else if (GB.find(ext => endsWith(toLower(attachment.name), ext))) {
      coreType = CoreType.GB;
    } else if (GBA.find(ext => endsWith(toLower(attachment.name), ext))) {
      coreType = CoreType.GBA;
    } else {
      return;
    }

    const { body } = await request(
      attachment.url_private_download,
      { headers: ['Authorization', `Bearer ${process.env.SLACK_BOT_TOKEN}`]}
    );
    const buffer = Buffer.from(await body.arrayBuffer());

    const id = uuid().slice(0, 5);

    const data = path.resolve('data', id);
    shelljs.mkdir('-p', data);

    const gameFile = path.join(data, attachment.name);
    fs.writeFileSync(gameFile, buffer);

    const info = {
      game: attachment.name,
      coreType,
      channel: message.channel
    };

    const infoFile = path.join(data, 'info.json');
    fs.writeFileSync(infoFile, JSON.stringify(info, null, 4));

    const { recording, state } = await emulate(pool, coreType, buffer, null, []);

    const stateFile = path.join(data, 'state.sav');
    fs.writeFileSync(stateFile, state);

    await client.files.upload({
      channels: message.channel,
      file: recording
    });

    await say({
      blocks: buttons(coreType, id, 1),
      text: 'Press button',
    });
  });

  app.action({type: 'block_actions', action_id: /^button.*/}, async ({ client, body, ack, say, action }) => {
    await ack();

    const { channel: { id: channel }, message: { ts } } = body;
    // For some reason `action` is not part of the TS type, so... yeah...
    const [id, button, multiplier] = JSON.parse(JSON.stringify(action)).value.split('-');

    if (fs.existsSync(path.resolve('data', id))) {
      const info = JSON.parse(fs.readFileSync(path.resolve('data', id, 'info.json')).toString());

      if (isNumeric(button)) {
        await client.chat.update({ channel, ts, text: 'Button pressed', blocks: [
          ...buttons(info.coreType, id, parseInt(button), button)
        ]});

        return;
      }

      const playerInputs = range(0, parseInt(multiplier)).map(() => parseInput(button));

      if (playerInputs.length > 0) {
        const info = JSON.parse(fs.readFileSync(path.resolve('data', id, 'info.json')).toString());

        let game = fs.readFileSync(path.resolve('data', id, info.game))
        let oldState = fs.readFileSync(path.resolve('data', id, 'state.sav'));

        const { ts: newTs } = await client.chat.update({ channel, ts, text: "Running, please wait...", blocks: [
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `'${joyToWord(first(playerInputs))}' button queued, please wait...`,
              "emoji": true
            }
          }
        ]});

        const { recording, state: newState } = await emulate(pool, info.coreType, game, oldState, playerInputs);

        fs.writeFileSync(path.resolve('data', id, 'state.sav'), newState);

        await say({
          text: `<@${body.user.name}> pressed '${joyToWord(first(playerInputs))}'${parseInt(multiplier) > 1 ? ' x' + multiplier : ''}.`,
        });

        await client.files.upload({
          channels: body.channel.id,
          file: recording
        });

        await say({
          text: 'Press button',
          blocks: buttons(info.coreType, id, 1),
        });

        await client.chat.delete({ channel, ts: newTs });
      }
    }
  });
}

const parseInput = (input: string) => {
  switch (toLower(input)) {
    case 'a':
      return { A: true };
    case 'b':
      return { B: true };
    case 'x':
      return { X: true };
    case 'y':
      return { Y: true };
    case 'l':
      return { L: true };
    case 'r':
      return { R: true };
    case 'up':
      return { UP: true };
    case 'down':
      return { DOWN: true };
    case 'left':
      return { LEFT: true };
    case 'right':
      return { RIGHT: true };
    case 'select':
      return { SELECT: true };
    case 'start':
      return { START: true };
  }
};

const buttons = (coreType: CoreType, id: string, multiplier: number = 1, highlight?: string) => {
  const createButton = (label: string) => {
    const button: any = {
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": label,
        "emoji": true
      },
      "value": `${id}-${label}-${multiplier}`,
      "action_id": `button_${label}`,
    }

    if (highlight === label) button.style = 'primary';

    return button;
  };

  const A = createButton('A');
  const B = createButton('B');
  const X = createButton('X');
  const Y = createButton('X');
  const L = createButton('L');
  const R = createButton('R');
  const UP = createButton('UP');
  const DOWN = createButton('DOWN');
  const LEFT = createButton('LEFT');
  const RIGHT = createButton('RIGHT');
  const SELECT = createButton('SELECT');
  const START = createButton('START');
  const MUL2 = createButton('2');
  const MUL4 = createButton('4');
  const MUL8 = createButton('8');
  const MUL10 = createButton('10');

  switch (coreType) {
    case CoreType.GB:
      return [
        {
          type: "actions",
          elements: [
            A, B, SELECT, START,
          ]
        },
        {
          type: "actions",
          elements: [
            UP, DOWN, LEFT, RIGHT
          ]
        },
        {
          type: "actions",
          elements: [
            MUL2, MUL4, MUL8, MUL10
          ]
        }
      ] as any[];

    case CoreType.GBA:
      return [
        {
          type: "actions",
          elements: [
            A, B
          ]
        },
        {
          type: "actions",
          elements: [
            UP, DOWN, LEFT, RIGHT
          ]
        },
        {
          type: "actions",
          elements: [
            SELECT, START, L, R
          ]
        },
        {
          type: "actions",
          elements: [
            MUL2, MUL4, MUL8, MUL10
          ]
        }
      ] as any[];

    case CoreType.NES:
      return [
        {
          type: "actions",
          elements: [
            A, B, SELECT, START
          ]
        },
        {
          type: "actions",
          elements: [
            UP, DOWN, LEFT, RIGHT
          ]
        },
        {
          type: "actions",
          elements: [
            MUL2, MUL4, MUL8, MUL10
          ]
        }
      ] as any[];

    case CoreType.SNES:
      return [
        {
          type: "actions",
          elements: [
            A, B, X, Y
          ]
        },
        {
          type: "actions",
          elements: [
            UP, DOWN, LEFT, RIGHT
          ]
        },
        {
          type: "actions",
          elements: [
            SELECT, START, L, R
          ]
        },
        {
          type: "actions",
          elements: [
            MUL2, MUL4, MUL8, MUL10
          ]
        }
      ] as any[];

    default:
      return [];
  }
}

const isNumeric = (value: string) => {
  return /^\d+$/.test(value);
};

const joyToWord = (input: InputState) => {
  if (input.A) return 'A';
  if (input.B) return 'B';
  if (input.X) return 'X';
  if (input.Y) return 'Y';
  if (input.L) return 'L';
  if (input.R) return 'R';
  if (input.UP) return 'Up';
  if (input.DOWN) return 'Down';
  if (input.LEFT) return 'Left';
  if (input.RIGHT) return 'Right';
  if (input.START) return 'Start';
  if (input.SELECT) return 'Select';
}

main().catch(err => {
  console.error(err);
  process.exit(1);
})
