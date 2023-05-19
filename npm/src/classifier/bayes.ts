import { AggressiveTokenizer, BayesClassifier, BayesClassifierClassification, WordTokenizer } from 'natural';
import { hamming, jWinkler, levenshtein, damerauLevenshtein, diceCoefficient } from './likeness';
import { AstroNLPFramework } from '../../lib';
import { IBlobRepo, ILogger } from 'service_utilities';

export class NLPService {

    public blobConnection: IBlobRepo;
    public defaultClassifierPath: string;
    public classifierList: Map<string, BayesClassifier> = new Map();
    private tokenizer: AggressiveTokenizer | WordTokenizer;
    private logger: ILogger;
    public nlpConfigs: AstroNLPFramework.TrainingConfigs;
    private curClassifier: BayesClassifier;

    constructor(public options?: AstroNLPFramework.NLPOptions) {
        if (options) {
            if (options.blobConnection) {
                this.blobConnection = options.blobConnection;
            }
            if (options.logger) {
                this.logger = options.logger;
            }
            if (options.configs) {
                this.nlpConfigs = options.configs;
            }
        }
    }

    public async getSetIfNullClassifier(classifierName: string, source: string, upload: boolean = false): Promise<void> {
        let classifier: BayesClassifier;
        try {
            this.logger.silly(`NLP CLASS | IN getSetIfNullClassifier`);
            await this.getClassifier(classifierName, source, true);
            this.logger.silly('WAS ABLE TO GET CLASSIFIER');
            return;
        } catch (error) {
            try {
                this.logger.silly('NLP CLASS | NOT ABLE TO GET CLASSIFIER - GOING TO SET');
                classifier = new BayesClassifier();
                await this.setClassifier(classifierName, classifier, upload, source);
                this.logger.silly('NLP CLASS | DONE WITH SET CLASSIFIER');
                return;
            } catch (error) {
                this.logger.error('ERROR SETTING NEW CLASSIFIER', { error: error });
                throw error;
            }
        }
    }

    public async getClassifier(classifierName: string, source: string, set?: boolean): Promise<BayesClassifier> {

        let classifier: BayesClassifier;

        try {

            // access_token = <string>await redisClient.get(redisKey); // access token from redis
            classifier = this.classifierList.get(classifierName);
            if (!classifier) {
                throw new Error('UNABLE TO GET CLASSIFIER FROM LIST');
            } else {
                this.logger.info(`GOT CLASSIFIER FROM EXISTING LIST`);
                return classifier;
            }
        } catch (error) {

            if (source === 'blob') {
                const stringifiedClassifier = await this.blobConnection.downloadBlob(classifierName);
                classifier = BayesClassifier.restore(JSON.parse(stringifiedClassifier));

                if (set === true) {
                    // const expiryTime = Number(process.env['SALESFORCE_REDIS_ACCESS_USER_EXPIRY']) || 5184000;
                    // await this.redisClient.set(redisUserKey, userName, 'EX', expiryTime);
                    this.classifierList.set(classifierName, classifier);
                }
                return classifier;

            } else if (source === 'fs') {
                classifier = await this.manageClassifierFS(classifierName, 'load');

                if (set === true) {
                    // const expiryTime = Number(process.env['SALESFORCE_REDIS_ACCESS_USER_EXPIRY']) || 5184000;
                    // await this.redisClient.set(redisUserKey, userName, 'EX', expiryTime);
                    this.classifierList.set(classifierName, classifier);
                }
                return classifier;

            } else {
                throw new Error('UNABLE TO DETERMINE CLASSIFIER SOURCE');
            }

        }

    }

    public async setClassifier(name: string, classifier?: BayesClassifier, upload?: boolean, destination?: string) {
        try {
            this.logger.silly('NLP CLASS | setClassifier | START', {
                upload: upload,
                destination: destination
            });
            if (!classifier) {
                try {
                    classifier = await this.getClassifier(name, 'blob');
                } catch (error) {
                    throw new Error('NLP CLASS | SET CLASSIFIER | CLASSIFIER UNDEFINED');
                }
            }
            // const expiryTime = Number(process.env['SALESFORCE_REDIS_ACCESS_USER_EXPIRY']) || 5184000;
            // await this.redisClient.set(redisUserKey, userName, 'EX', expiryTime);
            this.classifierList.set(name, classifier);
            if (upload) {
                if (destination) {
                    if (destination === 'fs') {
                        this.logger.debug('GOING TO MANAGE CLASSIFIERS IN FS');
                        await this.manageClassifierFS(name, 'load', classifier);
                        return;
                    } else if (destination === 'blob') {
                        this.logger.debug('GOING TO MANAGE CLASSIFIERS BLOB');

                        this.logger.debug('ABOUT TO CALL: this.setClassifiersBlob');
                        await this.setClassifiersBlob(name, JSON.stringify(classifier));
                        return;
                    } else {
                        throw new Error(`Unhandled destination: ${destination}`);
                    }
                } else {
                    throw new Error('Must specify destination when upload is true');
                }
            } else {
                return;
            }
        } catch (error) {
            this.logger.error('ERROR SETTING CLASSIFIER', { error: error });
        }
    }

    public async setClassifiersBlob(name: string, classifier: any) {
        try {
            this.logger.silly('IN setClassifiersBlob');
            await this.blobConnection.uploadBlob(name, classifier);
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    public manageClassifierFS(classifierName: string, operation: string, classifier?: BayesClassifier): Promise<BayesClassifier> {
        return new Promise((resolve, reject) => {
            if (operation === 'load') {
                BayesClassifier.load(`${classifierName}.json`, null, (err, loadedClassifier) => {
                    if (err) {
                        reject(err);
                    } else {
                        const curClassifier: BayesClassifier = loadedClassifier;
                        resolve(curClassifier);
                    }
                });
            } else if (operation === 'save') {
                if (classifier) {
                    classifier.save(`${name}.json`, (err, savedClassifier) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(savedClassifier);
                        }
                    });
                } else {
                    throw new Error(`No Classifier specified to perform operation: ${operation}`);
                }
            } else {
                throw new Error('OPERATION TYPE UNDEFINED IN FS MANAGEMENT');
            }
        });
    }

    public trainClassifierHandler(trainOptions: AstroNLPFramework.TrainingConfigs, classifierName: string, set?: boolean) {
        try {

            // access_token = <string>await redisClient.get(redisKey); // access token from redis
            if (!this.curClassifier || classifierName !== trainOptions.classifierName) {
                this.curClassifier = this.classifierList.get(trainOptions.classifierName);
            }

            const docCount = trainOptions.trainingDocs.length;
            trainOptions.trainingDocs.map((trainingDocs, trainingDocsIndex) => {

                if (trainingDocs.sourceValues && Array.isArray(trainingDocs.sourceValues) && trainingDocs.sourceValues.length >= 1) {

                    this.logger.silly('SOURCE VALUES', { source: trainingDocs.sourceValues });

                    trainingDocs.sourceValues.map((sourceVal: string, sourceValIndex) => {

                        this.logger.silly('TARGET VALUES', { source: trainingDocs.targetValues });

                        if (trainingDocs.targetValues && Array.isArray(trainingDocs.targetValues) && trainingDocs.targetValues.length >= 1) {
                            trainingDocs.targetValues.map((targetVal: string, targetValIndex) => {
                                this.logger.silly('NLP CLASS | TRAINING HANDLER | SINGLE PERMUTATION', {
                                    trainingDocsIndex: trainingDocsIndex,
                                    sourceValIndex: sourceValIndex,
                                    targetValIndex: targetValIndex
                                });

                                // if it is the last one or set is set to true:
                                // pass: set=true to this.train()
                                if (docCount === trainingDocsIndex + 1 && docCount !== 1 || set) {
                                    this.train(sourceVal, targetVal, trainingDocs.trainingOptions, trainOptions.classifierName, set);
                                } else {
                                    this.train(sourceVal, targetVal, trainingDocs.trainingOptions, trainOptions.classifierName, false);
                                }
                                this.logger.silly('NLP CLASS | TRAINING HANDLER | SINGLE PERMUTATION | DONE WITH this.train()');
                            });
                        }

                    });

                } else {
                    this.logger.error(`NO OPTIONS TO TRAIN ON OPTION ${trainingDocsIndex}`);
                }
            });
            
            this.logger.silly('NLP PACKAGE | LEAVING trainClassifierHandler');
            return;

        } catch (error) {
            this.logger.error('Astro Entity ERROR | trainClassifierHandler', { error: error });
            throw error;
        }
    }

    private train(sourceVal: string, targetVal: string, options: AstroNLPFramework.TrainingOptions, classifierName: string, set?: boolean) {
        try {
            // const classifier = this.classifierList.get(classifierName);
            this.curClassifier.addDocument(sourceVal, targetVal); // once classifier is handled, add the document (source value that should be trained to target value)
            // Now now that main document is added, train the variations applicable that were passed in the options
            if (!this.tokenizer && (options.tokenize || options.tokenizeShuffle)) { // if the options specify tokenization and there is no class tokenizer, load it
                if (options.tokenizerOptions === 'aggressive') {
                    this.tokenizer = new AggressiveTokenizer();
                } else if (options.tokenizerOptions === 'standard') {
                    this.tokenizer = new WordTokenizer();
                }
            }

            if (options.tokenize) {
                const tokenizedSourceValues = this.tokenizer.tokenize(sourceVal);
                tokenizedSourceValues.map((sourceValTokenPart) => {
                    if (options.shuffleToken) {
                        const shuffledTokenVal = this.shuffle(sourceValTokenPart);
                        this.curClassifier.addDocument(shuffledTokenVal, targetVal);
                    } else {
                        this.curClassifier.addDocument(sourceValTokenPart, targetVal);
                    }
                });
            }

            if (options.shuffle) {
                const shuffleSourceVal = this.shuffle(sourceVal);
                this.curClassifier.addDocument(shuffleSourceVal, targetVal);
                if (options.tokenizeShuffle) {
                    const tokenizedSourceValues = this.tokenizer.tokenize(shuffleSourceVal);
                    tokenizedSourceValues.map((sourceValTokenPart) => {
                        if (options.shuffleToken) {
                            const shuffledTokenVal = this.shuffle(sourceValTokenPart);
                            this.curClassifier.addDocument(shuffledTokenVal, targetVal);
                        } else {
                            this.curClassifier.addDocument(sourceValTokenPart, targetVal);
                        }
                    });
                }
            }

            if (set) {
                this.logger.silly(`NLP PACKAGE | COMPLETED PROCESSING DOCUMENTS FOR CLASSIFIER: ${classifierName} | Setting IN CLASSIFIER LIST`);
                this.classifierList.set(classifierName, this.curClassifier);
            }
            return;

        } catch (error) {
            this.logger.error('ERROR IN TRAIN METHOD', { error: error });
            throw error;
        }
    }

    public async classify(value: string, classifyOptions: AstroNLPFramework.ClassifyConfigs): Promise<string | BayesClassifierClassification[]> {
        try {
            let classifier: BayesClassifier;
            if (classifyOptions.classifier) {
                classifier = classifyOptions.classifier;
            } else if (classifyOptions.classifierName) {
                classifier = await this.getClassifier(classifyOptions.classifierName, 'blob');
            } else {
                throw new Error('INVALID CLASSIFIER OPTIONS');
            }
            let classifierRes;
            if (classifyOptions.response === 'fullScores') {
                classifierRes = classifier.getClassifications(value);
            } else if (classifyOptions.response === 'class') {
                classifierRes = classifier.classify(value);
            } else {
                throw new Error('INVALID CLASSIFY RESPONSE TYPE');
            }
            return classifierRes;
        } catch (error) {
            this.logger.error('ERROR CLASSIFYING INCOMING VALUE', {
                value: value,
                classifyOptions: classifyOptions
            });
            throw error;
        }
    }

    /**
     * @description Actually to calculate the probability of a typical naive bayes classifier where b is the base, it is . 
     * This is the inverse logit (http://en.wikipedia.org/wiki/Logit) 
     * However, given the independence assumptions of the NBC, these scores tend to be too high or too low and probabilities calculated this way will accumulate at the boundaries. 
     * It is better to calculate the scores in a holdout set and do a logistic regression of accurate(1 or 0) on score to get a better feel for the relationship between score and probability.
     * @param scoreConfigs configs can either be a single numeric score, or a raw score response. Please see the type defitinition for ScoreConfigs
     */
    public getScoreProbability(scoreConfigs: AstroNLPFramework.ScoreConfigs) {
        try {
            let probability: number;
            if (scoreConfigs.score) {
                probability = Math.pow(scoreConfigs.base, scoreConfigs.score) / (1 + Math.pow(scoreConfigs.base, scoreConfigs.score))
            } else if (scoreConfigs.classificationsResponse) {

            } else {
                throw new Error('UNHANDLED SCORE TYPE');
            }
        } catch (error) {

        }
    }

    /**
     * 
     * @param subject The string that you want to find a match for
     * @param test The string that you are testing to see if it is a match
     * @description This is where we would use the string distance from the natural package to determine the top 5 most similar string.
     * We would use the list to and allow the user to choose the correct string in order to train the classifier.  
     */
    public getClosetStringList(subject: string, test: string) {
        const rawDistances = {
            hamming: <number>hamming(subject, test),
            jWinkler: <number>jWinkler(subject, test),
            levenshtein: <number>levenshtein(subject, test),
            damerauLevenshtein: <number>damerauLevenshtein(subject, test),
            diceCoefficient: <number>diceCoefficient(subject, test)
        };
        return rawDistances;
    }

    /**
     * @returns string with characters shuffled
     * @param a string to be shuffled
     */
    public shuffle(a: any) {
        let j, x, i;
        for (i = a.length - 1; i > 0; i--) {
            j = Math.floor(Math.random() * (i + 1));
            x = a[i];
            a[i] = a[j];
            a[j] = x;
        }
        return a;
    }

    public createTrainingSet(populationData: Array<any>, gap: number) {
        this.logger.verbose(`POPULATION SIZE: ${populationData.length} | GAP: ${gap}`, {
            groups: (populationData.length / gap)
        });

        const arr = [];

        // avoid filter because you don't want
        // to loop over 10000 elements !
        // just access them directly with a for loop
        for (let i = 0; i < populationData.length; i = i + gap) {
            // if (i % 2 === 0) {
            //   arr.push(populationData[i + 1]);
            // }
            arr.push(populationData[i]);
        }

        this.logger.info(`TRAINING SET SIZE SET FOR CURRENT BATCH TO: ${arr.length}`);
        return arr;
    }

}
